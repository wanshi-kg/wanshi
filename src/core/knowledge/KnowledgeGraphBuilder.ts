import { z } from 'zod';
import { OllamaService, LLMMessage } from '../llm/OllamaService';
import { PromptManager, PromptContext } from '../llm/prompts/PromptManager';
import { ProcessedFile, KnowledgeGraph, ProcessedImage, IKnowledgeGraphBuilder } from '../../types';
import { logger } from '../../shared/logger';

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
  ollamaService: OllamaService;
  promptManager: PromptManager;
}

/**
 * Builds knowledge graphs from processed files using LLM
 */
export class KnowledgeGraphBuilder implements IKnowledgeGraphBuilder {
  private ollamaService: OllamaService;
  private promptManager: PromptManager;

  constructor(options: BuilderOptions) {
    this.ollamaService = options.ollamaService;
    this.promptManager = options.promptManager;
  }

  /**
   * Build a knowledge graph from a processed file
   */
  async build(
    processedFile: ProcessedFile,
    systemPrompt: string,
    retrievedContext?: any
  ): Promise<KnowledgeGraph[]> {
    logger.info(`Building knowledge graph for: ${processedFile.path}`);

    const graphs: KnowledgeGraph[] = [];

    // Process chunks if available
    if (processedFile.chunks && processedFile.chunks.length > 0) {
      for (const chunk of processedFile.chunks) {
        const kg = await this.buildFromChunk(
          processedFile.path,
          chunk.content,
          processedFile.content,
          systemPrompt,
          chunk.index,
          chunk.totalChunks,
          retrievedContext,
          processedFile?.images
        );

        // Add metadata to entities
        kg.entities.forEach(entity => {
          entity.files = [processedFile.path];
          entity.chunk = chunk.index;
          entity.totalChunks = chunk.totalChunks;
        });

        graphs.push(kg);
      }
    } else {
      // Process entire file
      const kg = await this.buildFromContent(
        processedFile.path,
        processedFile.content,
        systemPrompt,
        retrievedContext,
        processedFile.images
      );

      // Add metadata to entities
      kg.entities.forEach(entity => {
        entity.files = [processedFile.path];
      });

      graphs.push(kg);
    }

    return graphs;
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
    images?: ProcessedImage[]
  ): Promise<KnowledgeGraph> {
    logger.debug(`Building KG for chunk ${chunkIndex}/${totalChunks} of ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: fullContent,
      chunkContent: content,
      chunkIndex,
      totalChunks,
      retrievedContext
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
    images?: ProcessedImage[]
  ): Promise<KnowledgeGraph> {
    logger.debug(`Building KG for entire file: ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: content,
      chunkContent: content,
      retrievedContext
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
      const result = await this.ollamaService.generateStructured(
        messages,
        KnowledgeGraphSchema
      );

      // Ensure arrays exist
      result.entities ??= [];
      result.relations ??= [];

      logger.debug(`Generated KG with ${result.entities.length} entities and ${result.relations.length} relations`);

      return result as KnowledgeGraph;
    } catch (error) {
      logger.error(`Failed to generate knowledge graph: ${error}`);
      
      // Return empty graph on failure
      return {
        entities: [],
        relations: []
      };
    }
  }
}