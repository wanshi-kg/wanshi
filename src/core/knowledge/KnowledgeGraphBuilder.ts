import * as path from 'path';
import { z } from 'zod';
import { ILLMProvider, LLMMessage } from '../../types/ILLMProvider';
import { PromptManager, PromptContext } from '../llm/prompts/PromptManager';
import { ProcessedFile, KnowledgeGraph, ProcessedImage, IKnowledgeGraphBuilder, ClassificationResult } from '../../types';
import { CheckpointService } from '../checkpoint';
import { Logger, shutdown } from '../../shared';

// Define the schema for knowledge graph extraction
const KnowledgeGraphSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe("Unique entity name"),
      entityType: z.string().describe("Entity description"),
      observations: z
        .array(z.string())
        .describe("List of facts and observations about entity"),
    })
  ),
  relations: z.array(
    z.object({
      from: z.string().describe("Relation source entity"),
      to: z.string().describe("Relation target entity"),
      relationType: z.array(z.string()).describe("List of relation types"),
    })
  ),
});

export interface BuilderOptions {
  llmService: ILLMProvider;
  promptManager: PromptManager;
  // Resume support: when `resume` is set, each chunk's result is read from /
  // written to the checkpoint, keyed by content + model + prompt version.
  checkpoint?: CheckpointService;
  resume?: boolean;
  model: string;
  promptVersion?: string;
  // Discovery root (`options.input`). The checkpoint key uses the file path
  // *relative to this root* so moving the whole tree / changing the `input`
  // prefix doesn't invalidate the checkpoint.
  inputRoot?: string;
}

/**
 * Builds knowledge graphs from processed files using LLM
 */
export class KnowledgeGraphBuilder implements IKnowledgeGraphBuilder {
  private llmService: ILLMProvider;
  private promptManager: PromptManager;
  private checkpoint?: CheckpointService;
  private resume: boolean;
  private model: string;
  private promptVersion: string;
  private inputRoot: string;
  private logger: Logger;

  constructor(options: BuilderOptions, logger: Logger) {
    this.llmService = options.llmService;
    this.promptManager = options.promptManager;
    this.checkpoint = options.checkpoint;
    this.resume = options.resume ?? false;
    this.model = options.model;
    this.promptVersion = options.promptVersion ?? 'default';
    this.inputRoot = options.inputRoot ?? '';
    this.logger = logger;
  }

  /**
   * Stable identity for a file in the checkpoint key: the path relative to the
   * discovery root (`inputRoot`), normalized to posix separators. This makes
   * resume survive relocating the whole input tree or changing the `input`
   * prefix. Falls back to the raw path when there's no root or the file resolves
   * outside it (`..`), so behavior degrades gracefully rather than mis-keying.
   */
  private stablePathId(filePath: string): string {
    if (!this.inputRoot) return filePath;
    const rel = path.relative(this.inputRoot, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
    return rel.split(path.sep).join('/');
  }

  /**
   * Build a knowledge graph from a processed file
   */
  async build(
    processedFile: ProcessedFile,
    systemPrompt: string,
    retrieve?: (chunkContent: string) => Promise<any>
  ): Promise<KnowledgeGraph[]> {
    this.logger.info(`Building knowledge graph for: ${processedFile.path}`);

    const graphs: KnowledgeGraph[] = [];

    const contentClasses = processedFile.metadata?.classes;
    const multiChunk = processedFile.chunks.length > 1;

    // Process chunks if available
    if (multiChunk) {
      for (const chunk of processedFile.chunks) {
        // Cooperative interrupt: finish the in-flight chunk, then stop before
        // starting the next one so a partial graph can be flushed.
        if (shutdown.isRequested()) {
          this.logger.warn(
            `Interrupted — stopping at chunk ${chunk.index}/${chunk.totalChunks} of ${processedFile.path}`
          );
          break;
        }

        // Retrieve context for THIS chunk's content (per-chunk retrieval).
        const retrievedContext = retrieve ? await retrieve(chunk.content) : undefined;

        const kg = await this.buildChunk(
          processedFile.path,
          chunk.index,
          chunk.totalChunks,
          chunk.content,
          () =>
            this.buildFromChunk(
              processedFile.path,
              chunk.content,
              '', // TODO: What to do here? Do I need fileContent?
              systemPrompt,
              chunk.index,
              chunk.totalChunks,
              retrievedContext,
              chunk.images,
              contentClasses
            ),
          (entity) => {
            entity.files = [processedFile.path];
            entity.chunk = chunk.index;
            entity.totalChunks = chunk.totalChunks;
          }
        );

        graphs.push(kg);
      }
    } else if (processedFile.chunks.length === 1) {
      const chunk = processedFile.chunks[0];
      const { content, images } = chunk;
      const retrievedContext = retrieve ? await retrieve(content) : undefined;
      // Process entire file
      const kg = await this.buildChunk(
        processedFile.path,
        chunk.index ?? 1,
        chunk.totalChunks ?? 1,
        content,
        () =>
          this.buildFromContent(
            processedFile.path,
            content,
            systemPrompt,
            retrievedContext,
            images,
            contentClasses
          ),
        (entity) => {
          entity.files = [processedFile.path];
        }
      );

      graphs.push(kg);
    }

    return graphs;
  }

  /**
   * Run one chunk through the LLM, or restore it from the checkpoint when
   * resuming. Stored graphs already carry their entity metadata, so on a hit
   * we skip the LLM call entirely.
   */
  private async buildChunk(
    filePath: string,
    chunkIndex: number,
    totalChunks: number,
    content: string,
    generate: () => Promise<KnowledgeGraph>,
    attachMetadata: (entity: KnowledgeGraph['entities'][number]) => void
  ): Promise<KnowledgeGraph> {
    const relPath = this.stablePathId(filePath);
    const key =
      this.resume && this.checkpoint
        ? this.checkpoint.computeKey(
            relPath,
            chunkIndex,
            content,
            this.model,
            this.promptVersion
          )
        : undefined;

    if (key && this.checkpoint!.has(key)) {
      this.logger.info(
        `Skipping cached chunk ${chunkIndex}/${totalChunks} of ${filePath} (checkpoint hit)`
      );
      return this.checkpoint!.get(key)!;
    }

    const kg = await generate();
    kg.entities.forEach(attachMetadata);

    if (key) {
      await this.checkpoint!.append({
        key,
        filePath,
        relPath,
        chunkIndex,
        totalChunks,
        model: this.model,
        promptVersion: this.promptVersion,
        kg,
      });
    }

    return kg;
  }

  /**
   * Build knowledge graph from a chunk of content
   */
  private async buildFromChunk(
    filePath: string,
    content: string,
    fullContent: string,
    systemPrompt: string,
    chunkIndex: number,
    totalChunks: number,
    retrievedContext?: any,
    images?: ProcessedImage[],
    contentClasses?: ClassificationResult[]
  ): Promise<KnowledgeGraph> {
    this.logger.debug(`Building KG for chunk ${chunkIndex}/${totalChunks} of ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: fullContent,
      chunkContent: content,
      chunkIndex,
      totalChunks,
      retrievedContext,
      contentClasses
    });

    return this.generateKnowledgeGraph(systemPrompt, userPrompt, images);
  }

  /**
   * Build knowledge graph from entire content
   */
  private async buildFromContent(
    filePath: string,
    content: string,
    systemPrompt: string,
    retrievedContext?: any,
    images?: ProcessedImage[],
    contentClasses?: ClassificationResult[]
  ): Promise<KnowledgeGraph> {
    this.logger.debug(`Building KG for entire file: ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: content,
      chunkContent: content,
      retrievedContext,
      contentClasses
    });

    return this.generateKnowledgeGraph(systemPrompt, userPrompt, images);
  }

  /**
   * Generate knowledge graph using LLM
   */
  private async generateKnowledgeGraph(
    systemPrompt: string,
    userPrompt: string,
    images?: ProcessedImage[]
  ): Promise<KnowledgeGraph> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: userPrompt,
        images: images?.map(img => img.base64 ?? '')
      }
    ];

    try {
      const result = await this.llmService.generateStructured(
        messages,
        KnowledgeGraphSchema
      );

      // Ensure arrays exist
      result.entities ??= [];
      result.relations ??= [];

      this.logger.debug(`Generated KG with ${result.entities.length} entities and ${result.relations.length} relations`);

      return result as KnowledgeGraph;
    } catch (error) {
      this.logger.error(`Failed to generate knowledge graph: ${error}`);
      
      // Return empty graph on failure
      return {
        entities: [],
        relations: []
      };
    }
  }
}