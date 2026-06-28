import { ExportFormat, KnowledgeGraph, ProcessingOptions } from '.';

/**
 * One file in a directory-shaped export. `path` is relative to the output
 * directory (e.g. `ollama_service.md`). Used by formats that emit a folder of
 * documents (e.g. `openwebui`) rather than a single file.
 */
export interface ExportFile {
  path: string;
  content: string;
}

/**
 * Interface for Knowledge Graph Export services
 */
export interface IKnowledgeGraphExporter {
  /**
   * Export knowledge graph to a specific format.
   * `processingOptions` is forwarded to format strategies (e.g. the DOT
   * strategy reads `dotOptions`, graph title, and processing-config cluster).
   */
  export(
    knowledgeGraph: KnowledgeGraph,
    format: ExportFormat,
    processingOptions?: ProcessingOptions
  ): string;

  /**
   * Directory-shaped export: returns one `ExportFile` per output file when the
   * format writes a *folder* (e.g. `openwebui` → one markdown doc per entity),
   * or `undefined` for ordinary single-file formats. The caller treats `--output`
   * as a directory and writes each file into it.
   */
  exportFiles(
    knowledgeGraph: KnowledgeGraph,
    format: ExportFormat,
    processingOptions?: ProcessingOptions
  ): ExportFile[] | undefined;

  /**
   * Check if a format is supported
   */
  isFormatSupported(format: string): boolean;

  /**
   * Get list of supported formats
   */
  getSupportedFormats(): ExportFormat[];
}
