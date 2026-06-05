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
  IProgressEmitter
} from "../types";
import { PromptManager } from "./llm";
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
      `Input: ${options.input}, Filter: ${options.filter}, Output: ${options.output}, Model: ${options.model}`
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
      const finalKG = await this.mergeGraphs(knowledgeGraphs, logger);
      const outputPath = await this.exportKnowledgeGraph(finalKG, options);

      progress.emit({
        type: "export",
        format: options.exportFormat || "json",
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
      this.handleError(error, options.debug, logger);
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

    const fileProcessor = await this.container.resolve<IFileProcessor>(
      TYPES.FileProcessor
    );
    const kgBuilder = await this.container.resolve<IKnowledgeGraphBuilder>(
      TYPES.KnowledgeGraphBuilder
    );

    const total = files.length;
    let index = 0;
    for (const file of files) {
      index += 1;
      // Cooperative interrupt: stop before starting the next file so the
      // partial graph accumulated so far can still be merged and exported.
      if (shutdown.isRequested()) {
        logger.warn(`Interrupted — stopping before ${file}; flushing partial graph`);
        break;
      }

      progress.emit({ type: "file_start", index, total, path: file });
      try {
        // Retrieval sees prior output + graphs built so far this run; merge sees
        // only what's built this run (knowledgeGraphs).
        const retrievalContext = [...priorGraphs, ...knowledgeGraphs];
        const fileGraphs = await this.processFile(
          file,
          options,
          fileProcessor,
          kgBuilder,
          retrievalContext,
          logger
        );
        knowledgeGraphs.push(...fileGraphs);

        const entities = fileGraphs.reduce((n, g) => n + g.entities.length, 0);
        const relations = fileGraphs.reduce((n, g) => n + g.relations.length, 0);
        progress.emit({ type: "file_complete", index, total, path: file, entities, relations });

        if (options.debug) {
          await this.writeIntermediateResults(knowledgeGraphs, options.output);
        }
      } catch (error) {
        this.handleFileError(file, error, options.debug, logger);
        progress.emit({ type: "file_complete", index, total, path: file, entities: 0, relations: 0 });
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
    try {
      const parsed = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      if (Array.isArray(parsed)) return parsed as KnowledgeGraph[];
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.entities)) {
        return [parsed as KnowledgeGraph];
      }
      return [];
    } catch (error) {
      logger.warn(
        `Could not load prior graph at ${outputPath} for retrieval context (ignored): ${error}`
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
    logger: Logger
  ): Promise<KnowledgeGraph[]> {
    logger.info(`Processing: ${file}`);

    const processedFile = await fileProcessor.processFile(file);
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
      processedFile.metadata?.classes
    );

    return await kgBuilder.build(processedFile, systemPrompt, retrieve);
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
      limit: options.retrievalLimit || 3,
      includeObservations: true,
    };

    const search = (content: string) =>
      searchService.searchByFileContent(content, filePath, existingGraphs, searchOptions);

    if (options.retrievalScope === "file") {
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
    if (options.retrieval === "disabled") return false;
    if (options.retrieval === "enabled") return true;
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
    const exportFormat = options.exportFormat || "json";

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
