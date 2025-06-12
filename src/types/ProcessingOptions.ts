/**
 * Configuration options for knowledge graph processing
 * Cleaned up to remove conflicting boolean pairs and improve clarity
 */
export interface ProcessingOptions {
  config?: string;

  // Core Processing
  input: string;
  filter: string;
  output: string;
  description: string;

  // LLM Configuration
  model: string;
  host: string;
  temperature: number;
  repeatPenalty: number;
  contextLength: number;
  seed?: number;
  system: string;
  embeddingsModel: string;

  // Text Processing
  chunkSize: number;
  overlapSize: number;
  chunking: ChunkingMode;

  // Documents Processing
  docling: boolean;

  // TODO: Image Processing configs

  // Automatic Speech Recognition Processing
  asr: SpeechRecognitionMode;
  whisperModel: string;
  language: string;


  // Context Retrieval
  retrieval: RetrievalMode;
  retrievalLimit: number;

  // Knowledge Graph Merging
  entitySimilarityThreshold?: number;
  observationSimilarityThreshold?: number;
  enableSimilarityMerging?: boolean;

  // Export Options
  exportFormat?: ExportFormat;

  // Logging & Debug
  logLevel: 'debug' | 'info' | 'warning' | 'error';
  logFile: string;
  debug: boolean;
  silent: boolean;

  // Runtime Modes
  watch: boolean;
}

/**
 * Chunking behavior options
 */
export type ExportFormat = 'json' | 'jsonl' | 'mcp-jsonl' | 'dot';

/**
 * Chunking behavior options
 */
export type ChunkingMode = 'enabled' | 'disabled' | 'auto';

/**
 * Context retrieval behavior options
 */
export type RetrievalMode = 'enabled' | 'disabled' | 'auto';

/**
 * Automatic Speech Recognition mode options
 */
export type SpeechRecognitionMode = 'enabled' | 'disabled' | 'auto';