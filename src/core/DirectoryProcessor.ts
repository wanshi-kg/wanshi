import { glob } from "glob";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../shared/logger";
import { KnowledgeGraph } from "../types/KnowledgeGraph";
import { ProcessingOptions } from "../types/ProcessingOptions";
import { DIContainer, TYPES } from "./di";
import {
  IFileProcessor,
  IKnowledgeGraphBuilder,
  IKnowledgeGraphSearch,
  IKnowledgeGraphMerger,
  IKnowledgeGraphExporter,
  IDirectoryProcessor,
  ChunkingOptions,
  ProcessedFile,
  MergeOptions,
} from "../types";
import { PromptManager } from "./llm";

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
    logger.info(`Starting knowledge graph generation`);
    logger.info(
      `Input: ${options.input}, Filter: ${options.filter}, Output: ${options.output}, Model: ${options.model}`
    );

    try {
      // Orchestrate the workflow
      const files = await this.findFiles(options.input, options.filter);
      this.validateFilesFound(files, options.filter);

      const knowledgeGraphs = await this.processFiles(files, options);
      const finalKG = await this.mergeGraphs(knowledgeGraphs, options);
      await this.exportKnowledgeGraph(finalKG, options);

      this.logSuccess(finalKG, options.output);
    } catch (error) {
      this.handleError(error, options.debug);
      throw error;
    }
  }

  /**
   * Find files matching the filter pattern
   */
  private async findFiles(inputDir: string, filter: string): Promise<string[]> {
    const pattern = path.join(inputDir, filter);
    return await glob(pattern, { nodir: true });
  }

  /**
   * Validate that files were found
   */
  private validateFilesFound(files: string[], filter: string): void {
    if (files.length === 0) {
      const message = `No files found matching pattern: ${filter}`;
      logger.warn(message);
      throw new Error(message);
    }
    logger.info(`Found ${files.length} files to process`);
  }

  /**
   * Process multiple files and generate knowledge graphs
   */
  private async processFiles(
    files: string[],
    options: ProcessingOptions
  ): Promise<KnowledgeGraph[]> {
    const knowledgeGraphs: KnowledgeGraph[] = [];
    const chunkingOptions = this.createChunkingOptions(options);

    const fileProcessor = await this.container.resolve<IFileProcessor>(
      TYPES.FileProcessor
    );
    const kgBuilder = await this.container.resolve<IKnowledgeGraphBuilder>(
      TYPES.KnowledgeGraphBuilder
    );

    for (const file of files) {
      try {
        const fileGraphs = await this.processFile(
          file,
          chunkingOptions,
          options,
          fileProcessor,
          kgBuilder,
          knowledgeGraphs
        );
        knowledgeGraphs.push(...fileGraphs);

        if (options.debug) {
          await this.writeIntermediateResults(knowledgeGraphs, options.output);
        }
      } catch (error) {
        this.handleFileError(file, error, options.debug);
      }
    }

    return knowledgeGraphs;
  }

  /**
   * Process a single file
   */
  private async processFile(
    file: string,
    chunkingOptions: ChunkingOptions,
    options: ProcessingOptions,
    fileProcessor: IFileProcessor,
    kgBuilder: IKnowledgeGraphBuilder,
    existingGraphs: KnowledgeGraph[]
  ): Promise<KnowledgeGraph[]> {
    logger.info(`Processing: ${file}`);

    const processedFile = await fileProcessor.processFile(
      file,
      chunkingOptions
    );
    this.validateProcessedFile(processedFile, file);

    const retrievalContext = await this.getRetrievalContext(
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
      options.filter,
      options.description
    );

    return await kgBuilder.build(processedFile, systemPrompt, retrievalContext);
  }

  /**
   * Create chunking options from processing options
   */
  private createChunkingOptions(options: ProcessingOptions): ChunkingOptions {
    return {
      maxChunkSize: Number(options.chunkSize || 2000),
      overlapSize: Number(options.overlapSize || 100),
      enabled: this.shouldEnableChunking(options),
    };
  }

  /**
   * Determine if chunking should be enabled
   */
  private shouldEnableChunking(options: ProcessingOptions): boolean {
    // Fix the conflicting boolean pairs issue
    if (options.chunking === "disabled") return false;
    if (options.chunking === "enabled") return true;
    return true; // Auto (anyway true)
  }

  /**
   * Validate processed file content
   */
  private validateProcessedFile(
    processedFile: ProcessedFile,
    filePath: string
  ): void {
    const hasContent = processedFile.content?.trim();
    const hasImages = processedFile.images && processedFile.images.length > 0;

    if (!hasContent && !hasImages) {
      logger.warn(`No content extracted from: ${filePath}`);
      throw new Error(`No content extracted from file: ${filePath}`);
    }
  }

  /**
   * Get retrieval context for improved processing
   */
  private async getRetrievalContext(
    processedFile: ProcessedFile,
    filePath: string,
    existingGraphs: KnowledgeGraph[],
    options: ProcessingOptions
  ): Promise<any> {
    if (!this.shouldUseRetrieval(options) || existingGraphs.length === 0) {
      return undefined;
    }

    const searchService = await this.container.resolve<IKnowledgeGraphSearch>(
      TYPES.KnowledgeGraphSearch
    );
    return await searchService.searchByFileContent(
      processedFile.content,
      filePath,
      existingGraphs,
      {
        limit: options.retrievalLimit || 3,
        includeObservations: true,
      }
    );
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
    options: ProcessingOptions
  ): Promise<KnowledgeGraph> {
    logger.info(`Merging ${graphs.length} knowledge graphs`);

    const merger = await this.container.resolve<IKnowledgeGraphMerger>(
      TYPES.KnowledgeGraphMerger
    );

    const mergeOptions: MergeOptions = {
      entitySimilarityThreshold: options.entitySimilarityThreshold || 0.9,
      observationSimilarityThreshold:
        options.observationSimilarityThreshold || 0.9,
      model: options.embeddingsModel || "mxbai-embed-large:335m",
      host: options.host,
    };

    return await merger.merge(graphs, mergeOptions);
  }

  /**
   * Export knowledge graph in the requested format
   */
  private async exportKnowledgeGraph(
    knowledgeGraph: KnowledgeGraph,
    options: ProcessingOptions
  ): Promise<void> {
    await this.ensureOutputDirectory(options.output);

    const exporter = await this.container.resolve<IKnowledgeGraphExporter>(
      TYPES.KnowledgeGraphExporter
    );
    const exportFormat = options.exportFormat || "json";

    if (!exporter.isFormatSupported(exportFormat)) {
      throw new Error(
        `Unsupported export format: ${exportFormat}. Supported: ${exporter
          .getSupportedFormats()
          .join(", ")}`
      );
    }

    const outputContent = exporter.export(knowledgeGraph, exportFormat);
    const outputPath = this.getOutputPath(options.output, exportFormat);

    await fs.promises.writeFile(outputPath, outputContent);
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
    switch (format) {
      case "jsonl":
        return originalPath.endsWith(".jsonl")
          ? originalPath
          : originalPath.replace(/\.[^.]+$/, ".jsonl");
      case "mcp-jsonl":
        return originalPath.endsWith(".jsonl")
          ? originalPath
          : originalPath.replace(/\.[^.]+$/, ".mcp.jsonl");
      case "json":
      default:
        return originalPath.endsWith(".json")
          ? originalPath
          : originalPath.replace(/\.[^.]+$/, ".json");
    }
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
  private handleFileError(file: string, error: any, debug: boolean): void {
    logger.error(`Failed to process file ${file}: ${error.message || error}`);
  }

  /**
   * Handle general processing errors
   */
  private handleError(error: any, debug: boolean): void {
    logger.error(`Failed to process directory: ${error.message || error}`);
  }

  /**
   * Log successful completion
   */
  private logSuccess(knowledgeGraph: KnowledgeGraph, outputPath: string): void {
    logger.info(`Knowledge graph saved to: ${outputPath}`);
    logger.info(
      `Final graph: ${knowledgeGraph.entities.length} entities, ${knowledgeGraph.relations.length} relations`
    );
  }
}
