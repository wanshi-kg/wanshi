import { FileDiscoveryService } from "../src/core";
import { ContainerFactory, TYPES } from "../src/core/di";
import { IFileProcessor } from "../src/types";

async function main() {
  
  const container = ContainerFactory.createContainer({
    processingOptions: {
      // input: '/Volumes/2TB/papers/ml/',
      // input: '/Users/oleksii/Downloads/mds/',
      input: './test_content_classes',
      // input: '/Users/oleksii/Downloads/corpus/fulltext/',
      // input: './',
      filter: [ "**/*" ],
      // asr: 'enabled',
      // whisperModel: "medium",
      // translate: true,
      exclude: [ "node_modules/**", "dist/**", "doc-classifier/lib/**", "doc-classifier/bin/**", "t?.ts" ],
      classifier: "heuristic",
      logLevel: "debug",
      debug: false,
      silent: true,
    }
  });
  

  const fileDiscoveryService = await container.resolve<FileDiscoveryService>(TYPES.FileDiscoveryService);
  const files = await fileDiscoveryService.discover();
  const fileProcessor = await container.resolve<IFileProcessor>(TYPES.FileProcessor);
  const contents = await Promise.all(files.map(f => fileProcessor.processFile(f)));

  for (let result of contents) {
    console.log(result.path);
    console.log(result.metadata?.classes);
    console.log();
  }
}

main();