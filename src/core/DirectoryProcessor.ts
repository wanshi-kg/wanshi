import { glob } from "glob";
import * as fs from "fs";
import * as path from "path";
import { KnowledgeGraph } from "../types/KnowledgeGraph";
import { ProcessingOptions } from "../types/ProcessingOptions";
import { DIContainer, TYPES } from "./di";
import {
  IKnowledgeGraphBuilder,
  IKnowledgeGraphSearch,
  IKnowledgeGraphMerger,
  IKnowledgeGraphExporter,
  IDirectoryProcessor,
  ChunkingOptions,
  ProcessedFile,
  IFileProcessor,
  IProgressEmitter,
  ICorpusAnalyzer,
  CorpusProfile
} from "../types";
import { PromptManager } from "./llm";
import { AstSeedService } from "./processor/ast";
import { toRelPathId } from "./corpus";
import { buildReferenceGraph, resolveInternalTarget } from "./knowledge/references/ReferenceResolver";
import { isExternalTarget, RawLink, RawReferences } from "./processor/readers/referenceExtraction";
import { ProcessedRegistry } from "./processor/ProcessedRegistry";
import {
  PipelineRunner,
  GroundingTransform,
  RelationFilterTransform,
  GraphTransform,
  TransformContext,
} from "./pipeline";
import { Canonicalizer } from "./knowledge/canon";
import { IEmbeddingProvider } from "../types/IEmbeddingProvider";
import { ILLMProvider } from "../types/ILLMProvider";
import { Logger, shutdown } from "../shared";

export interface IFileDiscoveryService {
  discover(): Promise<string[]>;
}

export class FileDiscoveryService implements IFileDiscoveryService {
  private readonly dir: string;
  private readonly filter: string[];
  private readonly exclude: string[];
  private readonly logger: Logger;

  constructor(options: Pick<ProcessingOptions, "input" | "filter" | "exclude">, logger: Logger) {
    this.logger = logger;
    this.dir = options.input;
    this.filter = options.filter;
    this.exclude = options.exclude;
  }

  async discover(): Promise<string[]> {
    const patterns = this.filter.map(f => path.join(this.dir, f));
    const files = await glob(patterns, { nodir: true, ignore: this.exclude });

    if (files.length === 0) {
      const message = `No files found matching pattern: ${this.filter}`;
      this.logger.warn(message);
      throw new Error(message);
    }
    this.logger.info(`Found ${files.length} files to process`);

    return files;
  }
} 

/** Per-file processing result: the extracted graphs + the file's internal links
 * (surfaced so reference-driven ingestion can follow them). */
interface ProcessFileResult {
  graphs: KnowledgeGraph[];
  internalLinks: RawLink[];
}

/**
 * Refactored DirectoryProcessor using dependency injection
 * Focuses on orchestration while delegating business logic to services
 */
export class DirectoryProcessor implements IDirectoryProcessor {
  constructor(private container: DIContainer) {}

  /**
   * Process a directory and generate knowledge graphs
   */
  async processDirectory(options: ProcessingOptions): Promise<void> {
    const logger = await this.container.resolve<Logger>(TYPES.Logger);
    const progress = await this.container.resolve<IProgressEmitter>(TYPES.ProgressEmitter);
    const fileDiscoveryService = await this.container.resolve<IFileDiscoveryService>(TYPES.FileDiscoveryService);

    logger.info(`Starting knowledge graph generation`);
    logger.info(
      `Input: ${options.input}, Filter: ${options.filter}, Output: ${options.output}, Model: ${options.llm.model}`
    );

    try {
      // Orchestrate the workflow
      const files = await fileDiscoveryService.discover();
      progress.emit({ type: "discovery", totalFiles: files.length });

      const knowledgeGraphs = await this.processFiles(files, options);

      if (shutdown.isRequested()) {
        logger.warn(
          "Run interrupted — merging and exporting the partial graph collected so far. Re-run with --resume to continue."
        );
      }

      progress.emit({ type: "merge", graphCount: knowledgeGraphs.length });
      const mergedKG = await this.mergeGraphs(knowledgeGraphs, logger);
      const finalKG = await this.applyGraphTransforms(mergedKG, options, logger);
      const outputPath = await this.exportKnowledgeGraph(finalKG, options);

      progress.emit({
        type: "export",
        format: options.export.format,
        entities: finalKG.entities.length,
        relations: finalKG.relations.length,
        output: outputPath,
      });
      this.logSuccess(finalKG, outputPath, logger);
      progress.emit({
        type: "done",
        entities: finalKG.entities.length,
        relations: finalKG.relations.length,
        output: outputPath,
        interrupted: shutdown.isRequested(),
      });
    } catch (error) {
      this.handleError(error, options.logging.debug, logger);
      progress.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Process multiple files and generate knowledge graphs
   */
  public async processFiles(
    files: string[],
    options: ProcessingOptions
  ): Promise<KnowledgeGraph[]> {
    const knowledgeGraphs: KnowledgeGraph[] = [];

    const logger = await this.container.resolve<Logger>(TYPES.Logger);
    const progress = await this.container.resolve<IProgressEmitter>(TYPES.ProgressEmitter);

    // Load a prior output graph (if any) to seed retrieval CONTEXT only. It must
    // NOT enter the merge set: re-merging already-merged output into a fresh run
    // double-counts entities/observations on a plain (no --resume) re-run.
    const priorGraphs = await this.loadPriorGraphs(options.output, logger);

    // Optional corpus analysis pre-pass: build/load a corpus-specific glossary
    // (and cached per-file classification) once, before extraction.
    const corpusProfile = await this.buildCorpusProfile(files, options, logger);

    const fileProcessor = await this.container.resolve<IFileProcessor>(
      TYPES.FileProcessor
    );
    const kgBuilder = await this.container.resolve<IKnowledgeGraphBuilder>(
      TYPES.KnowledgeGraphBuilder
    );

    // Deterministic AST symbol seed (Phase 8): seed code definitions + exported
    // members (and calls/imports edges) per file so the LLM augments the symbol
    // set rather than originating it. Content-hash cached across the run.
    const astSeed =
      options.ast.mode === "enabled"
        ? await this.container.resolve<AstSeedService>(TYPES.AstSeedService)
        : undefined;
    await astSeed?.loadCache();

    // Reference & link resolution: the corpus-relative path set drives link
    // resolution (resolved-flag + follow targets). In follow mode it spans the
    // WHOLE input tree (links can point outside the glob); otherwise the glob set.
    const follow = options.references.follow.enabled;
    const internalLinksOn = options.references.internalLinks.enabled || follow;
    let corpusRelPaths: Set<string>;
    if (follow) {
      const allInput = await new FileDiscoveryService(
        { input: options.input, filter: ["**/*"], exclude: options.exclude },
        logger
      )
        .discover()
        .catch(() => [] as string[]);
      corpusRelPaths = new Set(allInput.map((f) => toRelPathId(options.input, f)));
    } else {
      corpusRelPaths = internalLinksOn
        ? new Set(files.map((f) => toRelPathId(options.input, f)))
        : new Set<string>();
    }

    // Worklist with a processed-file registry: the same file is read/extracted at
    // most once however it's reached (overlapping globs, reference-following). The
    // queue is seeded from follow.seeds (a crawl) or the discovered glob set, and
    // (in follow mode) grows as internal links are resolved to existing files.
    const registry = new ProcessedRegistry();
    const queued = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [];
    const enqueue = (file: string, depth: number) => {
      const id = toRelPathId(options.input, file);
      if (registry.has(id) || queued.has(id)) return;
      queued.add(id);
      queue.push({ file, depth });
    };

    const seeds = options.references.follow.seeds;
    if (follow && seeds.length) {
      for (const s of seeds) {
        const abs = path.resolve(options.input, s);
        if (fs.existsSync(abs)) enqueue(abs, 0);
        else logger.warn(`reference-follow seed not found, skipping: ${s}`);
      }
    } else {
      for (const f of files) enqueue(f, 0);
    }

    const { maxFiles, maxDepth } = options.references.follow;
    let index = 0;
    while (queue.length > 0) {
      // Cooperative interrupt: stop before starting the next file so the
      // partial graph accumulated so far can still be merged and exported.
      if (shutdown.isRequested()) {
        logger.warn(`Interrupted — flushing partial graph (${registry.size} files processed)`);
        break;
      }
      if (follow && registry.size >= maxFiles) {
        logger.warn(`reference-follow reached maxFiles=${maxFiles}; stopping discovery`);
        break;
      }

      const { file, depth } = queue.shift()!;
      const id = toRelPathId(options.input, file);
      if (registry.has(id)) continue; // already processed via another path

      index += 1;
      const total = registry.size + queue.length + 1;
      progress.emit({ type: "file_start", index, total, path: file });
      try {
        // Retrieval sees prior output + graphs built so far this run; merge sees
        // only what's built this run (knowledgeGraphs).
        const retrievalContext = [...priorGraphs, ...knowledgeGraphs];
        const { graphs: fileGraphs, internalLinks } = await this.processFile(
          file,
          options,
          fileProcessor,
          kgBuilder,
          retrievalContext,
          logger,
          corpusProfile,
          astSeed,
          corpusRelPaths
        );
        registry.mark(id);
        knowledgeGraphs.push(...fileGraphs);

        // Reference-driven ingestion: enqueue resolved internal-link targets that
        // exist in the corpus and haven't been processed/queued. Network-free —
        // external targets are skipped (that's Phase 1).
        if (follow && (maxDepth === 0 || depth < maxDepth)) {
          for (const link of internalLinks) {
            if (isExternalTarget(link.target)) continue;
            const rel = resolveInternalTarget(link, id, corpusRelPaths);
            if (rel && !registry.has(rel) && !queued.has(rel)) {
              enqueue(path.resolve(options.input, rel), depth + 1);
            }
          }
        }

        const entities = fileGraphs.reduce((n, g) => n + g.entities.length, 0);
        const relations = fileGraphs.reduce((n, g) => n + g.relations.length, 0);
        progress.emit({ type: "file_complete", index, total, path: file, entities, relations });

        if (options.logging.debug) {
          await this.writeIntermediateResults(knowledgeGraphs, options.output);
        }
      } catch (error) {
        registry.mark(id); // don't retry a hard-failing file in this run
        this.handleFileError(file, error, options.logging.debug, logger);
        progress.emit({ type: "file_complete", index, total: registry.size + queue.length, path: file, entities: 0, relations: 0 });
      }
    }

    // Persist the AST symbol cache so an unchanged file is a no-op next run.
    await astSeed?.saveCache();

    // Surface chunks whose extraction failed: they were left uncheckpointed (so
    // --resume retries them) and must not pass silently as "done-and-empty". The
    // partial graph still merges/exports; the run exits non-zero (KG-02).
    const failedChunks = kgBuilder.getFailedChunks();
    if (failedChunks.length > 0) {
      logger.warn(
        `${failedChunks.length} chunk(s) failed extraction and were left uncheckpointed — ` +
          `re-run with --resume to retry them:`
      );
      for (const f of failedChunks) {
        logger.warn(`  - ${f.filePath} [chunk ${f.chunkIndex}/${f.totalChunks}]: ${f.error}`);
      }
      process.exitCode = 1;
    }

    // Surface claims the inline grounding gate rejected (WI3 manifest trace):
    // in `drop` mode they were removed from the graph, in `flag` mode annotated
    // and kept — either way they must leave a visible trace, not vanish.
    const rejections = kgBuilder.getGroundingRejections();
    if (rejections.length > 0) {
      const dropped = rejections.filter((r) => r.dropped).length;
      logger.warn(
        `Grounding gate flagged ${rejections.length} ungrounded claim(s)` +
          (dropped > 0 ? ` (${dropped} dropped, ${rejections.length - dropped} flagged)` : ` (all flagged)`) +
          `:`
      );
      for (const r of rejections) {
        logger.debug(
          `  - [${r.kind}] ${r.subject} (score ${r.score.toFixed(2)}, ` +
            `${r.dropped ? "dropped" : "flagged"}) in ${r.filePath} [chunk ${r.chunkIndex}]: ${r.claim}`
        );
      }
    }

    return knowledgeGraphs;
  }

  /**
   * Load a previously-written output graph for retrieval seeding. Tolerates both
   * the current single-graph object (`{entities, relations}`) and a legacy array
   * of per-file graphs. Returns [] (and warns) when missing/unparseable — the
   * prior graph is a retrieval nicety, never required.
   */
  private async loadPriorGraphs(
    outputPath: string,
    logger: Logger
  ): Promise<KnowledgeGraph[]> {
    if (!outputPath || !fs.existsSync(outputPath)) return [];
    const raw = fs.readFileSync(outputPath, "utf-8");

    // JSONL / mcp-jsonl outputs aren't valid JSON documents — parse them
    // line-by-line (KG-11) instead of warning every run. Route by extension, and
    // also fall back to the JSONL reader if a `.json` somehow fails to parse.
    const isJsonl = /\.(jsonl|mcp-jsonl)$/i.test(outputPath);
    if (isJsonl) {
      const { JsonlExportStrategy } = await import("./export/strategies/JsonlExportStrategy");
      const graph = JsonlExportStrategy.fromJSONL(raw);
      return graph.entities.length || graph.relations.length ? [graph] : [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as KnowledgeGraph[];
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entities)) {
        return [parsed as KnowledgeGraph];
      }
      return [];
    } catch {
      // Not a JSON document — try JSONL before giving up (covers a mislabeled file).
      const { JsonlExportStrategy } = await import("./export/strategies/JsonlExportStrategy");
      const graph = JsonlExportStrategy.fromJSONL(raw);
      if (graph.entities.length || graph.relations.length) return [graph];
      logger.warn(
        `Could not load prior graph at ${outputPath} for retrieval context (ignored)`
      );
      return [];
    }
  }

  /**
   * Process a single file
   */
  private async processFile(
    file: string,
    options: ProcessingOptions,
    fileProcessor: IFileProcessor,
    kgBuilder: IKnowledgeGraphBuilder,
    existingGraphs: KnowledgeGraph[],
    logger: Logger,
    corpusProfile?: CorpusProfile,
    astSeed?: AstSeedService,
    corpusRelPaths: Set<string> = new Set()
  ): Promise<ProcessFileResult> {
    logger.info(`Processing: ${file}`);

    // Reuse the pre-pass's cached classification for this file when available.
    const cachedClasses =
      corpusProfile?.perFileClasses[toRelPathId(options.input, file)];
    const processedFile = await fileProcessor.processFile(file, cachedClasses);
    // A reader can signal a graceful skip (BinaryReader for binary/unknown
    // files) — honor it before the "no content extracted" guard turns an empty
    // read into a per-file error.
    if (processedFile.metadata?.skip) {
      logger.info(`Skipped ${file} (binary / no extractable text)`);
      return { graphs: [], internalLinks: [] };
    }
    this.validateProcessedFile(processedFile, file, logger);

    const retrieve = await this.buildRetriever(
      processedFile,
      file,
      existingGraphs,
      options
    );

    const promptManager = (await this.container.resolve(
      TYPES.PromptManager
    )) as PromptManager;
    const systemPrompt = await promptManager.getSystemPrompt(
      options.input,
      options.filter.join(', '),
      options.description,
      processedFile.metadata?.classes,
      corpusProfile?.glossary
    );

    const graphs = await kgBuilder.build(
      processedFile,
      systemPrompt,
      retrieve,
      corpusProfile?.glossary
    );

    // Append the deterministic AST symbol seed (Phase 8) so it merges with the
    // LLM's per-chunk graphs — the model augments the symbol set, not originates it.
    const seed = astSeed ? await astSeed.seedGraph(processedFile) : null;
    if (seed) graphs.push(seed);

    // Deterministic reference edges (Phase 0, network-free): internal links +
    // citations the document already contains, resolved against the corpus.
    // Merges with the LLM graphs like the AST seed above. Following auto-implies
    // internal-link resolution (you can't follow links you didn't extract).
    const internalLinksOn =
      options.references.internalLinks.enabled || options.references.follow.enabled;
    if (internalLinksOn || options.references.citations.enabled) {
      const refGraph = buildReferenceGraph(processedFile, corpusRelPaths, options.input, {
        internalLinks: internalLinksOn,
        citations: options.references.citations.enabled,
      });
      if (refGraph) graphs.push(refGraph);
    }

    const internalLinks =
      (processedFile.metadata?.references as RawReferences | undefined)?.internalLinks ?? [];
    return { graphs, internalLinks };
  }

  /**
   * Run the optional corpus analysis pre-pass (term frequency + cached
   * classification + LLM glossary). Returns undefined when disabled or on
   * failure — profiling is an enhancement, never required.
   */
  private async buildCorpusProfile(
    files: string[],
    options: ProcessingOptions,
    logger: Logger
  ): Promise<CorpusProfile | undefined> {
    if (options.corpus.profiling !== "enabled") return undefined;
    try {
      logger.info("Corpus analysis pre-pass enabled — profiling corpus before extraction");
      const analyzer = await this.container.resolve<ICorpusAnalyzer>(
        TYPES.CorpusAnalyzer
      );
      return await analyzer.analyzeOrLoad(files, options);
    } catch (error) {
      logger.warn(
        `Corpus pre-pass failed (continuing without a glossary): ${error}`
      );
      return undefined;
    }
  }

  /**
   * Validate processed file content
   */
  private validateProcessedFile(
    processedFile: ProcessedFile,
    filePath: string,
    logger: Logger
  ): void {
    if (!processedFile.chunks?.length) {
      logger.warn(`No content extracted from: ${filePath}`);
      throw new Error(`No content extracted from file: ${filePath}`);
    }
  }

  /**
   * Build a retrieval function for a file, or undefined when retrieval is
   * disabled / there's no existing graph to search.
   *
   * - `retrievalScope: "chunk"` (default) returns a function that retrieves
   *   context per chunk using that chunk's own content.
   * - `retrievalScope: "file"` retrieves once from the first chunk and reuses
   *   it for every chunk (legacy behavior).
   */
  private async buildRetriever(
    processedFile: ProcessedFile,
    filePath: string,
    existingGraphs: KnowledgeGraph[],
    options: ProcessingOptions
  ): Promise<((chunkContent: string) => Promise<any>) | undefined> {
    if (!this.shouldUseRetrieval(options) || existingGraphs.length === 0) {
      return undefined;
    }

    const searchService = await this.container.resolve<IKnowledgeGraphSearch>(
      TYPES.KnowledgeGraphSearch
    );
    const searchOptions = {
      limit: options.retrieval.limit,
      includeObservations: true,
    };

    const search = (content: string) =>
      searchService.searchByFileContent(content, filePath, existingGraphs, searchOptions);

    if (options.retrieval.scope === "file") {
      // Retrieve once from the first chunk, reuse for all chunks.
      const context = await search(processedFile.chunks[0].content);
      return async () => context;
    }

    // Default: per-chunk retrieval.
    return (chunkContent: string) => search(chunkContent);
  }

  /**
   * Determine if retrieval should be used
   */
  private shouldUseRetrieval(options: ProcessingOptions): boolean {
    // Fix the conflicting boolean pairs issue
    if (options.retrieval.mode === "disabled") return false;
    if (options.retrieval.mode === "enabled") return true;
    return true; // Auto to true
  }

  /**
   * Merge multiple knowledge graphs
   */
  private async mergeGraphs(
    graphs: KnowledgeGraph[],
    logger: Logger
  ): Promise<KnowledgeGraph> {
    logger.info(`Merging ${graphs.length} knowledge graphs`);

    const merger = await this.container.resolve<IKnowledgeGraphMerger>(
      TYPES.KnowledgeGraphMerger
    );

    return await merger.merge(graphs);
  }

  /**
   * Run the post-extraction graph→graph transform pipeline (grounding gate,
   * canonicalization) over the merged graph, in the order from `pipeline.stages`.
   * A no-op when no transform is enabled — the providers resolved here are the
   * same singletons extraction/merge already built, so the baseline path returns
   * the merged graph unchanged.
   */
  private async applyGraphTransforms(
    graph: KnowledgeGraph,
    options: ProcessingOptions,
    logger: Logger
  ): Promise<KnowledgeGraph> {
    const transforms: GraphTransform[] = [
      new GroundingTransform(),
      new Canonicalizer(),
      new RelationFilterTransform(), // after canon: endpoints are canonical before pairing
    ];

    const ctx: TransformContext = {
      options,
      embeddings: await this.container.resolve<IEmbeddingProvider>(
        TYPES.EmbeddingService
      ),
      llm: await this.container.resolve<ILLMProvider>(TYPES.LLMService),
      logger,
    };

    const runner = new PipelineRunner(transforms, ctx);
    if (!runner.hasWork()) return graph;
    return runner.run(graph);
  }

  /**
   * Export knowledge graph in the requested format
   */
  private async exportKnowledgeGraph(
    knowledgeGraph: KnowledgeGraph,
    options: ProcessingOptions
  ): Promise<string> {
    await this.ensureOutputDirectory(options.output);

    const exporter = await this.container.resolve<IKnowledgeGraphExporter>(
      TYPES.KnowledgeGraphExportService
    );
    const exportFormat = options.export.format;

    if (!exporter.isFormatSupported(exportFormat)) {
      throw new Error(
        `Unsupported export format: ${exportFormat}. Supported: ${exporter
          .getSupportedFormats()
          .join(", ")}`
      );
    }

    const outputContent = exporter.export(knowledgeGraph, exportFormat, options);
    const outputPath = this.getOutputPath(options.output, exportFormat);

    await fs.promises.writeFile(outputPath, outputContent);
    return outputPath;
  }

  /**
   * Ensure output directory exists
   */
  private async ensureOutputDirectory(outputPath: string): Promise<void> {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  /**
   * Get the final output path with correct extension
   */
  private getOutputPath(originalPath: string, format: string): string {
    return originalPath.endsWith(`.${format}`)
      ? originalPath
      : originalPath.replace(/\.[^.]+$/, `.${format}`);
  }

  /**
   * Write intermediate results for debugging
   */
  private async writeIntermediateResults(
    graphs: KnowledgeGraph[],
    outputPath: string
  ): Promise<void> {
    const tmpPath = outputPath + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(graphs, null, 2));
  }

  /**
   * Handle file processing errors
   */
  private handleFileError(file: string, error: any, debug: boolean, logger: Logger): void {
    logger.error(`Failed to process file ${file}: ${error.message || error}`);
  }

  /**
   * Handle general processing errors
   */
  private handleError(error: any, debug: boolean, logger: Logger): void {
    logger.error(`Failed to process directory: ${error.message || error}`);
  }

  /**
   * Log successful completion
   */
  private logSuccess(knowledgeGraph: KnowledgeGraph, outputPath: string, logger: Logger): void {
    logger.info(`Knowledge graph saved to: ${outputPath}`);
    logger.info(`Final graph: ${knowledgeGraph.entities.length} entities, ${knowledgeGraph.relations.length} relations`);
  }
}
