import { ExportFile, IKnowledgeGraphExporter } from "../../types/IKnowledgeGraphExporter";
import { KnowledgeGraph } from "../../types/KnowledgeGraph";
import { ExportFormat, ProcessingOptions } from "../../types/ProcessingOptions";
import { 
  IExportStrategy, 
  JsonExportStrategy,
} from "./strategies";

/**
 * Main export service that uses strategy pattern to handle different export formats
 * Implements proper dependency injection and separation of concerns
 */
export class KnowledgeGraphExportService implements IKnowledgeGraphExporter {
  private strategies = new Map<string, IExportStrategy>();

  constructor(...strategies: IExportStrategy[]) {
    if (strategies.length > 0) {
      strategies.forEach(x => this.registerStrategy(x));
    } else {
      // Register default strategies if not provided (fallback for legacy usage)
      this.registerStrategy(new JsonExportStrategy());
    }
  }

  /**
   * Register a new export strategy
   */
  registerStrategy(strategy: IExportStrategy): void {
    this.strategies.set(strategy.getFormat(), strategy);
  }

  /**
   * Export knowledge graph to specified format
   */
  export(
    knowledgeGraph: KnowledgeGraph, 
    format: ExportFormat,
    processingOptions?: ProcessingOptions
  ): string {
    const strategy = this.strategies.get(format);
    
    if (!strategy) {
      throw new Error(`Unsupported export format: ${format}. Supported formats: ${this.getSupportedFormats().join(", ")}`);
    }

    return strategy.export(knowledgeGraph, processingOptions);
  }

  /**
   * Directory-shaped export: returns one `ExportFile` per output file when the
   * format's strategy implements `exportFiles` (e.g. `openwebui`), else
   * `undefined` for ordinary single-file formats.
   */
  exportFiles(
    knowledgeGraph: KnowledgeGraph,
    format: ExportFormat,
    processingOptions?: ProcessingOptions
  ): ExportFile[] | undefined {
    const strategy = this.strategies.get(format);

    if (!strategy) {
      throw new Error(`Unsupported export format: ${format}. Supported formats: ${this.getSupportedFormats().join(", ")}`);
    }

    return strategy.exportFiles?.(knowledgeGraph, processingOptions);
  }

  /**
   * Check if a format is supported
   */
  isFormatSupported(format: string): boolean {
    return this.strategies.has(format);
  }

  /**
   * Get list of supported formats
   */
  getSupportedFormats(): ExportFormat[] {
    return Array.from(this.strategies.keys()) as ExportFormat[];
  }

  /**
   * Get a specific strategy (useful for advanced usage)
   */
  getStrategy(format: string): IExportStrategy | undefined {
    return this.strategies.get(format);
  }
}