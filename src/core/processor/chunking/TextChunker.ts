import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { logger } from '../../../shared/logger';
import { ChunkingOptions, ProcessedChunk } from "../../../types";

/**
 * Smart text chunking service using LangChain's RecursiveCharacterTextSplitter
 * Tries to split on natural boundaries (paragraphs, sentences, etc.)
 */
export class TextChunker {
  private readonly defaultSeparators = [
    "\n\n",  // Paragraph breaks
    "\n",    // Line breaks
    ". ",    // Sentence endings
    "? ",    // Question endings
    "! ",    // Exclamation endings
    "; ",    // Semicolons
    ", ",    // Commas
    " ",     // Spaces
    "",      // Character level as last resort
  ];

  /**
   * Chunk text into smaller pieces with overlap
   */
  async chunk(
    text: string, 
    options: ChunkingOptions
  ): Promise<ProcessedChunk[]> {
    if (!options.enabled || text.length <= options.maxChunkSize) {
      return [{
        content: text,
        index: 1,
        totalChunks: 1,
        startOffset: 0,
        endOffset: text.length,
      }];
    }

    logger.debug(`Chunking text of length ${text.length} with max size ${options.maxChunkSize}`);

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: options.maxChunkSize,
      chunkOverlap: options.overlapSize,
      separators: this.defaultSeparators,
    });

    const chunks = await splitter.splitText(text);
    
    logger.info(`Split text into ${chunks.length} chunks`);

    return chunks.map((chunk, index) => ({
      content: chunk,
      index: index + 1,
      totalChunks: chunks.length,
      startOffset: this.calculateStartPosition(chunks, index, options.overlapSize),
      endOffset: this.calculateEndPosition(chunks, index, options.overlapSize)
    }));
  }

  /**
   * Calculate approximate start position of chunk in original text
   */
  private calculateStartPosition(
    chunks: string[], 
    index: number, 
    overlapSize: number
  ): number {
    if (index === 0) return 0;
    
    let position = 0;
    for (let i = 0; i < index; i++) {
      position += chunks[i].length;
      if (i < index - 1) {
        position -= overlapSize;
      }
    }
    return position;
  }

  /**
   * Calculate approximate end position of chunk in original text
   */
  private calculateEndPosition(
    chunks: string[], 
    index: number, 
    overlapSize: number
  ): number {
    return this.calculateStartPosition(chunks, index, overlapSize) + chunks[index].length;
  }

  /**
   * Create a custom splitter with specific separators
   */
  createCustomSplitter(
    separators: string[], 
    chunkSize: number, 
    overlapSize: number
  ): RecursiveCharacterTextSplitter {
    return new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap: overlapSize,
      separators
    });
  }
}