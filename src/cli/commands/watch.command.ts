import * as chokidar from 'chokidar';
import * as path from 'path';
import { logger } from '../../shared/logger';
import { ContainerFactory, DIContainer, TYPES } from '../../core/di';
import { IDirectoryProcessor, ProcessingOptions } from '../../types';

/**
 * Watch command - monitors directory for changes and regenerates knowledge graph
 */
export async function watchCommand(options: ProcessingOptions): Promise<void> {
  logger.info("Watch mode enabled - monitoring for file changes...");

  const watcher = chokidar.watch(path.join(options.input, options.filter), {
    ignored: /^\./,
    persistent: true,
  });

  let processing = false;

    const container = ContainerFactory.createContainer({ processingOptions: options });
    const processor = await container.resolve<IDirectoryProcessor>(TYPES.DirectoryProcessor);
  const processWithDebounce = async () => {
    if (processing) return;
    processing = true;

    try {
      await processor.processDirectory(options);
    } catch (error) {
      logger.error(`Watch mode processing failed: ${error}`);
    } finally {
      processing = false;
    }
  };

  watcher
    .on("add", () => processWithDebounce())
    .on("change", () => processWithDebounce())
    .on("unlink", () => processWithDebounce());

  // Initial processing
  await processWithDebounce();

  // Keep the process running
  process.on("SIGINT", () => {
    logger.info("Stopping watch mode...");
    watcher.close();
    process.exit(0);
  });
}