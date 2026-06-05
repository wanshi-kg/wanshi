/**
 * Configuration options for knowledge graph processing
 * Cleaned up to remove conflicting boolean pairs and improve clarity
 */
export interface ProcessingOptions {
  config?: string;

  // Core Processing
  input: string;
  filter: string[];
  exclude: string[];
  output: string;
  description: string;

  // LLM Configuration
  provider: LLMProviderMode;
  model: string;
  host: string; // Ollama host, or OpenAI-compatible base URL when provider="openai"
  apiKey?: string; // API key for OpenAI-compatible provider
  temperature: number;
  repeatPenalty: number;
  contextLength: number;
  maxTokens?: number;
  seed: number | undefined;
  system: string;
  promptVersion?: string;

  // Document Outline (injected into the user prompt). YAML-only nested group,
  // like dotOptions. Forwarded to the document-outline-gen library.
  outline?: OutlineOptions;

  // Embeddings Configuration (independent from generation provider)
  embeddingsProvider: LLMProviderMode;
  embeddingsModel: string;
  embeddingsHost: string;
  embeddingsApiKey?: string;
  embeddingsMaxInputChars: number;

  // Resume / Continuation
  resume: boolean;
  checkpointPath?: string;

  // Text Processing
  chunking: ChunkingMode;
  chunkSize: number;
  overlapSize: number;

  // Documents Processing
  docling: boolean;

  // JSON Reader (token-efficient, structure-aware). CLI: --json-strategy
  jsonStrategy?: "structural" | "raw";
  jsonReader?: {
    strategy?: "structural" | "raw";
    maxChunkSize?: number;
  };

  // Image Processing
  images: ImageProcessingMode;

  // [EXPERIMENTAL] Content Classification
  classifier: ContentClassifierMode;

  // Automatic Speech Recognition Processing
  asr: SpeechRecognitionMode;
  whisperModel: string;
  language: string;
  translate: boolean;

  // Context Retrieval
  retrieval: RetrievalMode;
  retrievalLimit: number;
  retrievalScope: RetrievalScope;

  // Knowledge Graph Merging
  entitySimilarityThreshold: number;
  observationSimilarityThreshold: number;
  enableSimilarityMerging: boolean;

  // Export Options
  exportFormat?: ExportFormat;

  // Dot Export Options
  dotOptions: {
    layout?: "dot" | "neato" | "fdp" | "sfdp" | "circo" | "twopi";
    rankdir?: "TB" | "BT" | "LR" | "RL";
    nodeShape?: string;
    edgeStyle?: string;
    colorScheme?: "default" | "scientific" | "code" | "minimal";
    includeObservations?: boolean;
    maxObservationsPerNode?: number;
    clusterByEntityType?: boolean;
    clusterByFile?: boolean;
    showLegend?: boolean;
  };

  // Logging & Debug
  logLevel: "debug" | "info" | "warning" | "error";
  logFile: string;
  debug: boolean;
  silent: boolean;

  // Progress reporting. When true, structured progress events and log lines are
  // emitted as newline-delimited JSON on stdout (demuxed by a `channel` field)
  // for a parent process / UI to consume. Built-in pretty logging is suppressed
  // to keep stdout a clean NDJSON stream. Default false (no behavior change).
  progressNdjson?: boolean;

  // Runtime Modes
  watch: boolean;
  exportOnly?: boolean;
}

/**
 * Chunking behavior options
 */
export type ExportFormat = "json" | "jsonl" | "mcp-jsonl" | "dot";

/**
 * Chunking behavior options
 */
export type ChunkingMode = "enabled" | "disabled" | "auto";

/**
 * Context retrieval behavior options
 */
export type RetrievalMode = "enabled" | "disabled" | "auto";

/**
 * Retrieval granularity:
 * - "chunk": retrieve context per chunk using that chunk's content (default)
 * - "file": retrieve once per file from the first chunk, reused for all chunks (legacy)
 */
export type RetrievalScope = "file" | "chunk";

/**
 * Automatic Speech Recognition mode options
 */
export type SpeechRecognitionMode = "enabled" | "disabled" | "auto";

export type ImageProcessingMode = "enabled" | "disabled" | "auto";

export type ContentClassifierMode = "disabled" | "llm" | "bert" | "heuristic";

/**
 * Document outline options. The outline is generated per file from its content
 * and injected into the user prompt as `{{fileOutline}}`. Maps onto the
 * document-outline-gen library's GeneratorOptions (plus an `enabled` toggle).
 */
export interface OutlineOptions {
  enabled?: boolean;          // default true; set false to skip outline generation
  maxDepth?: number;          // limit nesting depth
  includeLineNumbers?: boolean;
  includePrivate?: boolean;   // include private/internal members
  includeComments?: boolean;
}

/**
 * LLM / embedding provider backend.
 * - "ollama": local Ollama client
 * - "openai": any OpenAI-compatible endpoint (OpenAI, OpenRouter, vLLM, ...)
 */
export type LLMProviderMode = "ollama" | "openai";