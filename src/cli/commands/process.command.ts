import { ContainerFactory, DIContainer, TYPES } from '../../core/di';
import { logger } from '../../shared/logger';
import { IDirectoryProcessor, ProcessingOptions } from '../../types';

/**
 * Process command - handles one-time directory processing
 */
export async function processCommand(options: ProcessingOptions): Promise<void> {
  try {
    const container = ContainerFactory.createContainer({ processingOptions: options });
    const processor = await container.resolve<IDirectoryProcessor>(TYPES.DirectoryProcessor);
    await processor.processDirectory(options);
  } catch (error) {
    logger.error(`Process command failed: ${error}`);
    throw error;
  }
}