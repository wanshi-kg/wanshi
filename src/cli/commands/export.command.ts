import * as fs from "fs";
import * as path from "path";
import { DIContainer, TYPES } from "../../core/di";
import { Logger } from "../../shared";
import {
  IKnowledgeGraphExporter,
  KnowledgeGraph,
  ProcessingOptions,
} from "../../types";

/**
 * Export command — convert an existing knowledge-graph JSON file (`--input`)
 * into another export format (`--export-format`), written to `--output`.
 * Reuses the same `KnowledgeGraphExportService` strategies as the main pipeline.
 */
export async function exportCommand(container: DIContainer): Promise<void> {
  const logger = await container.resolve<Logger>(TYPES.Logger);
  const options = await container.resolve<ProcessingOptions>(
    TYPES.ProcessingOptions
  );

  try {
    const sourcePath = options.input;
    if (
      !sourcePath ||
      !fs.existsSync(sourcePath) ||
      fs.statSync(sourcePath).isDirectory()
    ) {
      throw new Error(
        `In export mode, --input must point to an existing knowledge-graph JSON file (got: ${sourcePath})`
      );
    }

    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
    // Tolerate both a single merged graph object and a legacy array of graphs.
    const graph: KnowledgeGraph = Array.isArray(parsed)
      ? flattenGraphs(parsed as KnowledgeGraph[])
      : (parsed as KnowledgeGraph);

    if (!graph || !Array.isArray(graph.entities)) {
      throw new Error(
        `--input does not contain a knowledge graph ({ entities, relations }): ${sourcePath}`
      );
    }
    graph.relations ??= [];

    const exporter = await container.resolve<IKnowledgeGraphExporter>(
      TYPES.KnowledgeGraphExportService
    );
    const format = options.export.format;
    if (!exporter.isFormatSupported(format)) {
      throw new Error(
        `Unsupported export format: ${format}. Supported: ${exporter
          .getSupportedFormats()
          .join(", ")}`
      );
    }

    // Directory-shaped formats (e.g. openwebui) write a folder of files.
    const files = exporter.exportFiles(graph, format, options);
    if (files) {
      const outputDir = options.output.replace(/\.[^./\\]+$/, "");
      await fs.promises.mkdir(outputDir, { recursive: true });
      for (const file of files) {
        const filePath = path.join(outputDir, file.path);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, file.content);
      }
      logger.info(
        `Exported knowledge graph from ${sourcePath} to ${outputDir}/ (${format}): ` +
          `${graph.entities.length} entities → ${files.length} files`
      );
    } else {
      const content = exporter.export(graph, format, options);
      await fs.promises.writeFile(options.output, content);

      logger.info(
        `Exported knowledge graph from ${sourcePath} to ${options.output} (${format}): ` +
          `${graph.entities.length} entities, ${graph.relations.length} relations`
      );
    }
  } catch (error) {
    logger.error(`Export command failed: ${error}`);
    throw error;
  }
}

/** Concatenate a legacy array of per-file graphs into one graph. */
function flattenGraphs(graphs: KnowledgeGraph[]): KnowledgeGraph {
  return {
    entities: graphs.flatMap((g) => g.entities ?? []),
    relations: graphs.flatMap((g) => g.relations ?? []),
  };
}
