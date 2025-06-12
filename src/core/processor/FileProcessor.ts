import { logger } from '../../shared/logger';
import * as path from 'path';
import { ChunkingOptions, IFileProcessor, ProcessedFile } from '../../types';
import { TextChunker } from './chunking';
import { FileReaderFactory } from './readers';

/**
 * Main file processor that coordinates reading and chunking
 */
export class FileProcessor implements IFileProcessor {
  private readonly textChunker: TextChunker;
  private readonly readerFactory: FileReaderFactory;

  constructor(readerFactory: FileReaderFactory) {
    this.textChunker = new TextChunker();
    this.readerFactory = readerFactory;
  }

  /**
   * Process a single file - read and optionally chunk it
   */
  async processFile(
    filePath: string, 
    chunkingOptions?: ChunkingOptions
  ): Promise<ProcessedFile> {
    logger.info(`Processing file: ${filePath}`);

    // Get appropriate reader
    const reader = this.readerFactory.getReader(filePath);
    if (!reader) {
      logger.warn(`No reader available for file: ${filePath}`);
      return {
        path: filePath,
        content: '',
        metadata: { 
          error: 'No reader available',
          fileType: path.extname(filePath) 
        }
      };
    }

    try {
      // Read the file
      const readResult = await reader.read(filePath);
      
      // Process chunks if needed
      if (chunkingOptions?.enabled && readResult.content.length > chunkingOptions.maxChunkSize) {
        const chunks = await this.textChunker.chunk(readResult.content, chunkingOptions);

        logger.info(`File ${filePath} chunked into ${chunks.length} parts`);

        return {
          path: filePath,
          content: readResult.content,
          chunks,
          images: readResult.images?.map(buffer => {
            return {
              path: filePath,
              caption: '',
              base64: buffer.toString('base64'),
            };
          }),
          metadata: {
            ...readResult.metadata,
            chunked: true,
            chunkCount: chunks.length
          }
        };
      }

      // Return unchunked result
      return {
        path: filePath,
        content: readResult.content,
        images: readResult.images?.map(buffer => {
          return {
            path: filePath,
            caption: '',
            base64: buffer.toString('base64'),
          };
        }),
        metadata: {
          ...readResult.metadata,
          chunked: false
        }
      };
    } catch (error) {
      logger.error(`Failed to process file ${filePath}: ${error}`);
      throw new Error(`Failed to process file ${filePath}: ${error}`);
    }
  }

  /**
   * Process multiple files in parallel
   */
  async processFiles(
    filePaths: string[], 
    chunkingOptions?: ChunkingOptions,
    concurrency: number = 5
  ): Promise<ProcessedFile[]> {
    logger.info(`Processing ${filePaths.length} files with concurrency ${concurrency}`);
    
    const results: ProcessedFile[] = [];
    const queue = [...filePaths];
    const inProgress: Promise<ProcessedFile>[] = [];

    while (queue.length > 0 || inProgress.length > 0) {
      // Start new tasks up to concurrency limit
      while (inProgress.length < concurrency && queue.length > 0) {
        const filePath = queue.shift()!;
        inProgress.push(this.processFile(filePath, chunkingOptions));
      }

      // Wait for at least one task to complete
      if (inProgress.length > 0) {
        const result = await Promise.race(inProgress);
        results.push(result);
        
        // Remove completed task
        const index = inProgress.findIndex(async p => (await p) === result);
        if (index !== -1) {
          inProgress.splice(index, 1);
        }
      }
    }

    logger.info(`Processed ${results.length} files successfully`);
    return results;
  }

  /**
   * Check if a file can be processed
   */
  canProcess(filePath: string): boolean {
    return this.readerFactory.canRead(filePath);
  }
}