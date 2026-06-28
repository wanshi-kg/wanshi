import { KnowledgeGraph } from "../../../types/KnowledgeGraph";
import { ExportFile } from "../../../types/IKnowledgeGraphExporter";
import { ProcessingOptions } from "../../../types/ProcessingOptions";

/**
 * Base interface for export strategies
 */
export interface IExportStrategy {
  /**
   * Export the knowledge graph to string format
   */
  export(graph: KnowledgeGraph, processingOptions?: ProcessingOptions): string;

  /**
   * Optional directory-shaped export: return one `ExportFile` per output file
   * when this format writes a *folder* (e.g. `openwebui`). When present, the
   * caller treats `--output` as a directory and writes each file into it.
   * Strategies that only implement `export()` keep the single-file path.
   */
  exportFiles?(
    graph: KnowledgeGraph,
    processingOptions?: ProcessingOptions
  ): ExportFile[];

  /**
   * Get the format identifier this strategy handles
   */
  getFormat(): string;
  
  /**
   * Check if this strategy supports the given format
   */
  supportsFormat(format: string): boolean;
}