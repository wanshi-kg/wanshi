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
import { buildImageMetaGraph } from "./knowledge/images/imageMetaGraph";
import { isExternalTarget, RawCitation, RawLink, RawReferences } from "./processor/readers/referenceExtraction";
import { ProcessedRegistry } from "./processor/ProcessedRegistry";
import { GatedFetcher } from "./knowledge/references/web/GatedFetcher";
import { FetchCacheService } from "./knowledge/references/web/FetchCacheService";
import { WebExtractFn, WebReferenceProcessor } from "./knowledge/references/web/WebReferenceProcessor";
import {
  CitationEvidenceProcessor,
  CitationExtractFn,
} from "./knowledge/references/citations/CitationEvidenceProcessor";
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
import { trace } from "./trace";
import { meter } from "./cost";
import { StructuredAdapterRegistry } from "./adapters";

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
  /** All links the file contains (internal + external); the worklist follows the
   * internal ones and the web fetcher takes the external ones. */
  links: RawLink[];
  /** Citations the file contains (Phase 2 citation span-fetch consumes these). */
  citations: RawCitation[];
}

/**
 * Refactored DirectoryProcessor using dependency injection
 * Focuses on orchestration while delegating business logic to services
 */
export class DirectoryProcessor implements IDirectoryProcessor {
  constructor(private container: DIContainer) {}

  /**
   * Names of entities that live outside this run's extracted set but are legitimate
   * edge endpoints (KG-04): the loaded prior-graph entities + corpus-glossary
   * `entityNames`, both already fed to retrieval so the v5 prompt points relations at
   * them by name. Computed in `processFiles` (where both are in scope) and consumed by
   * `mergeGraphs` so a compliant cross-run edge isn't dropped as a true dangler. Empty
   * on the common default run (no prior graph, no glossary) ⇒ merge is byte-identical.
   */
  private knownExternalEndpointNames: Set<string> = new Set<string>();

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

    // Debug trace: open the run. A resumed run skips checkpointed chunks, so its
    // trace is partial — flagged here.
    trace.emit({
      stage: "run", type: "run_start",
      output: options.output,
      resumed: !!options.resume?.enabled,
      config: { model: options.llm.model, promptVersion: options.llm.promptVersion, grounding: options.grounding?.mode },
    });

    // Cost meter: attach the resolved logger (configured in ContainerFactory without one).
    if (meter.enabled) meter.attachLogger(logger);

    try {
      // Orchestrate the workflow
      const files = await fileDiscoveryService.discover();
      progress.emit({ type: "discovery", totalFiles: files.length });

      // Rough pre-run cost estimate (bill-shock heads-up; the end tally is exact).
      if (meter.enabled) await this.logCostEstimate(files, options, logger);

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
      trace.emit({
        stage: "export", type: "export",
        format: options.export.format,
        entities: finalKG.entities.length,
        relations: finalKG.relations.length,
      });
      this.logSuccess(finalKG, outputPath, logger);
      // Cost meter: exact end-of-run tally (persisting the ledger happens in finally).
      if (meter.enabled) logger.info(meter.summary());
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
    } finally {
      // WS-23: persist the resume-safe cumulative ledger even when a step after
      // extraction (merge/canon/export) crashes — otherwise this run's spend is
      // lost from the cumulative total. persistLedger is best-effort/never-throws.
      if (meter.enabled) meter.persistLedger();
    }
  }

  /** Rough pre-run cost projection from discovered file sizes (bytes≈chars; no double read pass). */
  private async logCostEstimate(
    files: string[],
    options: ProcessingOptions,
    logger: Logger
  ): Promise<void> {
    let totalChars = 0;
    for (const f of files) {
      try {
        totalChars += (await fs.promises.stat(f)).size;
      } catch {
        /* unreadable/removed — skip */
      }
    }
    const est = meter.estimate(totalChars, options.chunking.size, options.llm.model);
    const tokens = est.estPromptTokens + est.estCompletionTokens;
    const money = est.priced
      ? `~${options.cost.currency} ${est.estCost.toFixed(est.estCost < 1 ? 4 : 2)}`
      : `no price set (shown as ${options.cost.currency} 0)`;
    logger.info(
      `Cost estimate (rough): ~${est.estChunks} chunk(s), ~${tokens.toLocaleString()} tokens for ` +
        `model '${options.llm.model}' — ${money}. Resume-cached chunks reduce actual spend; the ` +
        `end-of-run tally is exact.`
    );
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
    // KG-11: the writer rewrites the output extension to match the export format
    // (getOutputPath), so seed from that same path — else `output: kg.json` +
    // `format: jsonl` looks for a non-existent kg.json and silently seeds nothing.
    const priorGraphs = await this.loadPriorGraphs(
      this.getOutputPath(options.output, options.export.format),
      logger
    );

    // Optional corpus analysis pre-pass: build/load a corpus-specific glossary
    // (and cached per-file classification) once, before extraction.
    const corpusProfile = await this.buildCorpusProfile(files, options, logger);

    // KG-04: the names retrieval can surface but merge won't re-extract — prior-graph
    // entities + corpus-glossary entityNames. A v5-compliant edge pointing at one of
    // these (by name, not re-emitted) must survive the dangling-edge gate; this set is
    // threaded to mergeGraphs. Empty when there's no prior graph and no glossary (the
    // common default), so the merge stays byte-identical to before.
    const externalNames = new Set<string>();
    for (const g of priorGraphs) {
      for (const e of g.entities) externalNames.add(e.name);
    }
    for (const name of corpusProfile?.glossary.entityNames ?? []) externalNames.add(name);
    this.knownExternalEndpointNames = externalNames;

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

    // Structured-emit adapters (data-sink track): a graph-native source (e.g. a
    // .db) maps directly to graph fragments, bypassing the LLM. Empty registry =
    // every file takes the normal read→build path (default).
    const structuredAdapters = await this.container
      .resolve<StructuredAdapterRegistry>(TYPES.StructuredAdapterRegistry)
      .catch(() => new StructuredAdapterRegistry()); // empty = off-path default

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

    // Phase 1 — class-3 external web fetcher (opt-in; constructed only when
    // references.web.enabled, so a default run never builds the network layer).
    const webProc = options.references.web.enabled
      ? await this.buildWebProcessor(options, fileProcessor, kgBuilder, corpusProfile, logger)
      : null;

    // Phase 2 — citation span-fetch (opt-in; constructed only when
    // references.citations.fetch.enabled). Resolves id-bearing cites to OA full
    // text, span-selects the citing claim's evidence, and labels the edge.
    const citeProc = options.references.citations.fetch.enabled
      ? await this.buildCitationProcessor(options, fileProcessor, kgBuilder, corpusProfile, logger)
      : null;

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
        const { graphs: fileGraphs, links: fileLinks, citations: fileCitations } = await this.processFile(
          file,
          options,
          fileProcessor,
          kgBuilder,
          retrievalContext,
          logger,
          corpusProfile,
          astSeed,
          corpusRelPaths,
          structuredAdapters
        );
        registry.mark(id);
        knowledgeGraphs.push(...fileGraphs);

        // Reference-driven ingestion: enqueue resolved internal-link targets that
        // exist in the corpus and haven't been processed/queued. Network-free —
        // external targets are skipped (that's the web fetcher below).
        if (follow && (maxDepth === 0 || depth < maxDepth)) {
          for (const link of fileLinks) {
            if (isExternalTarget(link.target)) continue;
            const rel = resolveInternalTarget(link, id, corpusRelPaths);
            if (rel && !registry.has(rel) && !queued.has(rel)) {
              enqueue(path.resolve(options.input, rel), depth + 1);
            }
          }
        }

        // Phase 1 — class-3 external web: fetch this file's allowlisted external
        // links (gated), extract, emit `references` edges. Depth-1 (fetched pages
        // are not re-crawled). Offline unless references.web is enabled.
        if (webProc) {
          const webGraph = await webProc.process(id, fileLinks, options.description);
          if (webGraph) knowledgeGraphs.push(webGraph);
        }

        // Phase 2 — citation span-fetch: resolve this file's id-bearing cites to OA
        // full text, fold content + label faithfulness. Offline unless enabled.
        if (citeProc) {
          const citeGraph = await citeProc.process(id, file, fileCitations);
          if (citeGraph) knowledgeGraphs.push(citeGraph);
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
    corpusRelPaths: Set<string> = new Set(),
    structuredAdapters?: StructuredAdapterRegistry
  ): Promise<ProcessFileResult> {
    logger.info(`Processing: ${file}`);

    // Structured-emit path (data-sink track): if an adapter claims this file, it
    // maps the source DIRECTLY to graph fragments (bypassing read→chunk→LLM). The
    // fragment still enters the per-file graphs[] union → merge/canon.
    const adapter = structuredAdapters?.match(file);
    if (adapter) {
      logger.info(`Structured adapter '${adapter.id}' handling ${file} (graph-native, no LLM)`);
      const graph = await adapter.extract(file);
      if (trace.enabled) {
        trace.emit({
          stage: "ingest", type: "chunk", chunkId: `${file}#0`, file,
          chunkIndex: 0, totalChunks: 1, reader: `adapter:${adapter.id}`, contentLength: 0,
        });
      }
      return { graphs: graph ? [graph] : [], links: [], citations: [] };
    }

    // Reuse the pre-pass's cached classification for this file when available.
    const cachedClasses =
      corpusProfile?.perFileClasses[toRelPathId(options.input, file)];
    const processedFile = await fileProcessor.processFile(file, cachedClasses);
    // A reader can signal a graceful skip (BinaryReader for binary/unknown
    // files) — honor it before the "no content extracted" guard turns an empty
    // read into a per-file error.
    if (processedFile.metadata?.skip) {
      logger.info(`Skipped ${file} (binary / no extractable text)`);
      return { graphs: [], links: [], citations: [] };
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
      corpusProfile?.glossary,
      options.pipeline.extraction.openPredicate,
      options.pipeline.extraction.strictVocabulary
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

    // Deterministic image metadata (EXIF/C2PA): graph facts that AUGMENT the VLM's
    // read of an image rather than replacing it (sourceAdapter exif/c2pa, confidence).
    // No-op (returns null) unless a reader stashed metadata.exif/metadata.c2pa.
    const imageGraph = buildImageMetaGraph(processedFile, options.input);
    if (imageGraph) graphs.push(imageGraph);

    // Deterministic reference edges (Phase 0, network-free): internal links +
    // citations the document already contains, resolved against the corpus.
    // Merges with the LLM graphs like the AST seed above. Following auto-implies
    // internal-link resolution (you can't follow links you didn't extract).
    const internalLinksOn =
      options.references.internalLinks.enabled || options.references.follow.enabled;
    // When citation-fetch is on (Phase 2), the CitationEvidenceProcessor OWNS the
    // `cites` edges (resolved + faithfulness) — so the network-free resolver stands
    // down on citations to avoid emitting a competing resolved:false edge.
    const fetchOwnsCites = options.references.citations.fetch.enabled;
    const citationsForResolver = options.references.citations.enabled && !fetchOwnsCites;
    if (internalLinksOn || citationsForResolver) {
      const refGraph = buildReferenceGraph(processedFile, corpusRelPaths, options.input, {
        internalLinks: internalLinksOn,
        citations: citationsForResolver,
      });
      if (refGraph) graphs.push(refGraph);
    }

    const refs = processedFile.metadata?.references as RawReferences | undefined;
    return { graphs, links: refs?.links ?? [], citations: refs?.citations ?? [] };
  }

  /**
   * Build the Phase-1 web reference processor: the DI-managed gated fetcher +
   * fetch cache, plus an extract closure that runs a fetched page through the
   * normal reader + builder (content only — no reference-resolver/follow on
   * fetched pages = depth-1).
   */
  private async buildWebProcessor(
    options: ProcessingOptions,
    fileProcessor: IFileProcessor,
    kgBuilder: IKnowledgeGraphBuilder,
    corpusProfile: CorpusProfile | undefined,
    logger: Logger
  ): Promise<WebReferenceProcessor> {
    const fetcher = await this.container.resolve<GatedFetcher>(TYPES.GatedFetcher);
    const cache = await this.container.resolve<FetchCacheService>(TYPES.FetchCacheService);
    const promptManager = (await this.container.resolve(TYPES.PromptManager)) as PromptManager;
    const extract: WebExtractFn = async (tempPath) => {
      const pf = await fileProcessor.processFile(tempPath);
      if (pf.metadata?.skip || !pf.chunks.length) return [];
      const systemPrompt = await promptManager.getSystemPrompt(
        options.input,
        options.filter.join(", "),
        options.description,
        pf.metadata?.classes,
        corpusProfile?.glossary,
        options.pipeline.extraction.openPredicate,
        options.pipeline.extraction.strictVocabulary
      );
      return kgBuilder.build(pf, systemPrompt, undefined, corpusProfile?.glossary);
    };
    return new WebReferenceProcessor(fetcher, cache, extract, logger);
  }

  /**
   * Build the Phase-2 citation evidence processor: a PDF-capable gated fetcher +
   * its own fetch cache + the id→OA resolver, an extract closure that runs a
   * fetched cited PDF through the normal reader (chunks for span-select) + builder
   * (content folded onto the cited-work node), the embedding provider for
   * span-select, and (optionally) GROBID for marker→claim linking + MiniCheck for
   * the faithfulness label.
   */
  private async buildCitationProcessor(
    options: ProcessingOptions,
    fileProcessor: IFileProcessor,
    kgBuilder: IKnowledgeGraphBuilder,
    corpusProfile: CorpusProfile | undefined,
    logger: Logger
  ): Promise<CitationEvidenceProcessor> {
    const { CitationResolver } = await import("./knowledge/references/citations/CitationResolver");
    const fetcher = await this.container.resolve<GatedFetcher>(TYPES.CitationFetcher);
    const cache = await this.container.resolve<FetchCacheService>(TYPES.CitationFetchCache);
    const resolver = await this.container.resolve<InstanceType<typeof CitationResolver>>(TYPES.CitationResolver);
    const embeddings = await this.container.resolve<IEmbeddingProvider>(TYPES.EmbeddingService);
    const promptManager = (await this.container.resolve(TYPES.PromptManager)) as PromptManager;
    const cfg = options.references.citations;

    const grobid = cfg.grobid.enabled
      ? await this.container.resolve<any>(TYPES.GrobidClient)
      : null;
    if (grobid && !(await grobid.isAlive())) {
      logger.warn(
        `GROBID not reachable at ${cfg.grobid.url} — citation span-select/faithfulness disabled (id-bearing fetch still runs). Start it with: docker run -p 8070:8070 lfoppiano/grobid`
      );
    }

    let faithfulness: any = null;
    if (cfg.fetch.minicheck) {
      const { MiniCheckGroundingChecker } = await import("./knowledge/grounding");
      faithfulness = new MiniCheckGroundingChecker(
        { model: cfg.fetch.minicheckModel, host: cfg.fetch.minicheckHost, min: 0.5, escalateAbove: 1.1 },
        logger
      );
    }

    const extract: CitationExtractFn = async (tempPath) => {
      const pf = await fileProcessor.processFile(tempPath);
      if (pf.metadata?.skip || !pf.chunks.length) return { chunks: [], graphs: [] };
      const chunks = pf.chunks.map((ch) => ch.content);
      const systemPrompt = await promptManager.getSystemPrompt(
        options.input,
        options.filter.join(", "),
        options.description,
        pf.metadata?.classes,
        corpusProfile?.glossary,
        options.pipeline.extraction.openPredicate,
        options.pipeline.extraction.strictVocabulary
      );
      const graphs = await kgBuilder.build(pf, systemPrompt, undefined, corpusProfile?.glossary);
      return { chunks, graphs };
    };

    return new CitationEvidenceProcessor(fetcher, cache, resolver, extract, embeddings, logger, {
      grobid,
      faithfulness,
      uncertainBand: cfg.fetch.uncertainBand,
    });
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

    // KG-04: pass the prior-graph + glossary names so a v5-compliant edge pointing at a
    // retrieved (not re-emitted) entity survives the dangling-edge gate. Empty set ⇒
    // no behavior change.
    return await merger.merge(graphs, this.knownExternalEndpointNames);
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
      new RelationFilterTransform(), // run order is governed by pipeline.stages, not this array (relationFilter is listed after canonicalization there)
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
