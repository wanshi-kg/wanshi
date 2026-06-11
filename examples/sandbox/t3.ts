import { ContainerFactory, TYPES } from "../src/core/di";
import { readFileSync, writeFileSync } from "fs";
import {
  IKnowledgeGraphExporter,
  IKnowledgeGraphMerger,
  KnowledgeGraph,
  ProcessingOptions,
} from "../src/types";

const options: Partial<ProcessingOptions> = {
  model: "",
  embeddingsModel: "",
  host: "",
  debug: true,
};

const container = ContainerFactory.createContainer({
  processingOptions: options,
});

main();

async function main() {
  const fileContent = readFileSync("/Users/oleksii/Downloads/mds/cvs/out/4_qwen2.5-coder_1.5b_v4.dot.tmp", "utf-8");
  const graphs = JSON.parse(fileContent) as KnowledgeGraph[];

  const mergerService = await container.resolve<IKnowledgeGraphMerger>(
    TYPES.KnowledgeGraphMerger
  );

  const exportService = await container.resolve<IKnowledgeGraphExporter>(
    TYPES.KnowledgeGraphExportService
  );

  const mergedGraphs = await mergerService.merge(graphs);

  const exported = exportService.export(mergedGraphs, "dot");

  writeFileSync("/Users/oleksii/Downloads/mds/cvs/out/4_qwen2.5-coder_1.5b_v4.dot", exported, "utf-8");
}
