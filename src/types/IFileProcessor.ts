import { ChunkingOptions, ProcessedFile } from './IProcessingService';
import { ClassificationResult } from './ContentClass';

/**
 * Interface for File Processing services
 */

export interface IFileProcessor {
  /**
   * Process a single file. `cachedClasses`, when supplied (e.g. from the corpus
   * pre-pass), is reused instead of re-running the content classifier.
   */
  processFile(
    filePath: string,
    cachedClasses?: ClassificationResult[]
  ): Promise<ProcessedFile>;

  /**
   * Check if a file type is supported
   */
  canProcess(filePath: string): boolean;
}
