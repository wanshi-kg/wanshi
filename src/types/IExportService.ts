import { ExportFormat, KnowledgeGraph } from '.';

/**
 * Interface for Knowledge Graph Export services
 */
export interface IKnowledgeGraphExporter {
  /**
   * Export knowledge graph to a specific format
   */
  export(knowledgeGraph: KnowledgeGraph, format: ExportFormat): string;
  
  /**
   * Check if a format is supported
   */
  isFormatSupported(format: string): boolean;
  
  /**
   * Get list of supported formats
   */
  getSupportedFormats(): ExportFormat[];
}

/**
 * Interface for Knowledge Graph Converter (static methods wrapper)
 */
export interface IKnowledgeGraphConverter {
  toJSON(knowledgeGraph: KnowledgeGraph): string;
  toJSONL(knowledgeGraph: KnowledgeGraph): string;
  toMCPJSONL(knowledgeGraph: KnowledgeGraph): string;
}