/**
 * UI layout metadata for the config form. JSON Schema (from `configJsonSchema`)
 * already carries types, enums, defaults and help text; this adds what JSON
 * Schema cannot express — widget hints (model/host/password/path/lines pickers),
 * grouping + ordering, and the cross-field credential wiring the run form needs.
 *
 * This is the backend source of truth for the form: the `schema` command emits
 * it alongside the JSON Schema so the frontend renders fields without
 * re-declaring them. Paths are dotted into the nested config (e.g. "llm.model").
 */

export type FieldWidget =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "lines"
  | "path"
  | "model"
  | "host";

export interface ConfigFieldMeta {
  /** Dotted path into the nested config, e.g. "llm.model". */
  path: string;
  label: string;
  widget: FieldWidget;
  placeholder?: string;
  required?: boolean;
  /** Part of the typed run-request core the frontend validates client-side. */
  core?: boolean;
  /** Path-like value the frontend resolves to absolute on import. */
  pathLike?: boolean;
  /** Frontend owns this — never imported or sent (it is forced per-run). */
  controlled?: boolean;
  /** Cross-field wiring for the model/host/credential pickers (sibling paths). */
  providerPath?: string;
  hostPath?: string;
  apiKeyPath?: string;
}

export interface ConfigGroupMeta {
  id: string;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  fields: ConfigFieldMeta[];
}

export const CONFIG_GROUPS: ConfigGroupMeta[] = [
  {
    id: "input",
    title: "Input",
    description: "Directory and file patterns to process.",
    defaultOpen: true,
    fields: [
      { path: "input", label: "Input directory", widget: "path", required: true, core: true, pathLike: true },
      { path: "filter", label: "Include patterns (one per line)", widget: "lines", required: true, core: true },
      { path: "exclude", label: "Exclude patterns (one per line)", widget: "lines", core: true },
      { path: "description", label: "Description", widget: "text", placeholder: "short description for the LLM" },
    ],
  },
  {
    id: "generation",
    title: "Generation",
    description: "LLM provider and sampling.",
    defaultOpen: true,
    fields: [
      { path: "llm.provider", label: "Provider", widget: "select", core: true },
      { path: "llm.model", label: "Model", widget: "model", required: true, core: true, providerPath: "llm.provider", hostPath: "llm.host", apiKeyPath: "llm.apiKey" },
      { path: "llm.host", label: "Host / base URL", widget: "host", core: true, providerPath: "llm.provider", apiKeyPath: "llm.apiKey" },
      { path: "llm.apiKey", label: "API key", widget: "password", core: true },
      { path: "llm.temperature", label: "Temperature", widget: "number" },
      { path: "llm.repeatPenalty", label: "Repeat penalty (Ollama)", widget: "number" },
      { path: "llm.contextLength", label: "Context length (Ollama)", widget: "number" },
      { path: "llm.maxTokens", label: "Max output tokens", widget: "number", placeholder: "(provider default)" },
      { path: "llm.seed", label: "Seed (Ollama)", widget: "number", placeholder: "(none)" },
      { path: "llm.system", label: "System prompt or template path", widget: "text" },
      { path: "llm.promptVersion", label: "Prompt version", widget: "text", placeholder: "v5" },
    ],
  },
  {
    id: "output",
    title: "Output",
    description: "Where and how to write the graph.",
    defaultOpen: true,
    fields: [
      { path: "output", label: "Output file", widget: "path", required: true, core: true, pathLike: true },
      { path: "export.format", label: "Export format", widget: "select", core: true },
    ],
  },
  {
    id: "embeddings",
    title: "Embeddings",
    description: "Independent provider for dedup / retrieval.",
    fields: [
      { path: "embeddings.provider", label: "Provider", widget: "select" },
      { path: "embeddings.model", label: "Model", widget: "model", providerPath: "embeddings.provider", hostPath: "embeddings.host", apiKeyPath: "embeddings.apiKey" },
      { path: "embeddings.host", label: "Host / base URL", widget: "host", providerPath: "embeddings.provider", apiKeyPath: "embeddings.apiKey" },
      { path: "embeddings.apiKey", label: "API key", widget: "password" },
      { path: "embeddings.maxInputChars", label: "Max input chars", widget: "number" },
    ],
  },
  {
    id: "chunking",
    title: "Text & chunking",
    fields: [
      { path: "chunking.mode", label: "Chunking", widget: "select" },
      { path: "chunking.size", label: "Chunk size (chars)", widget: "number", core: true },
      { path: "chunking.overlap", label: "Overlap size (chars)", widget: "number" },
    ],
  },
  {
    id: "media",
    title: "Media (images · ASR · documents)",
    fields: [
      { path: "readers.images", label: "Images", widget: "select" },
      { path: "readers.asr.mode", label: "Audio (ASR)", widget: "select" },
      { path: "readers.asr.whisperModel", label: "Whisper model", widget: "text" },
      { path: "readers.asr.language", label: "Language", widget: "text" },
      { path: "readers.asr.translate", label: "Translate to English", widget: "boolean" },
      { path: "readers.docling", label: "Use Docling for PDF/Office", widget: "boolean" },
      { path: "readers.stripReferences", label: "Strip references/bibliography", widget: "boolean" },
    ],
  },
  {
    id: "jsonReader",
    title: "JSON reader",
    fields: [
      { path: "readers.json.strategy", label: "Strategy", widget: "select" },
      { path: "readers.json.maxChunkSize", label: "Max chunk size", widget: "number", placeholder: "(inherits chunk size)" },
    ],
  },
  {
    id: "classifier",
    title: "Classifier (experimental)",
    fields: [{ path: "classifier.mode", label: "Classifier", widget: "select" }],
  },
  {
    id: "retrieval",
    title: "Retrieval",
    fields: [
      { path: "retrieval.mode", label: "Retrieval", widget: "select" },
      { path: "retrieval.limit", label: "Limit", widget: "number" },
      { path: "retrieval.scope", label: "Scope", widget: "select" },
    ],
  },
  {
    id: "grounding",
    title: "Grounding",
    fields: [
      { path: "grounding.mode", label: "Grounding gate", widget: "select" },
      { path: "grounding.minScore", label: "Min score", widget: "number" },
      { path: "grounding.checker", label: "Checker", widget: "select" },
      { path: "grounding.model", label: "MiniCheck model", widget: "text" },
      { path: "grounding.escalateAbove", label: "Keyword pre-filter band", widget: "number" },
    ],
  },
  {
    id: "merging",
    title: "Merging",
    fields: [
      { path: "merging.entitySimilarityThreshold", label: "Entity similarity threshold", widget: "number" },
      { path: "merging.observationSimilarityThreshold", label: "Observation similarity threshold", widget: "number" },
      { path: "merging.enableSimilarityMerging", label: "Enable similarity merging", widget: "boolean" },
    ],
  },
  {
    id: "corpus",
    title: "Corpus profiling (experimental)",
    fields: [
      { path: "corpus.profiling", label: "Corpus profiling", widget: "select" },
      { path: "corpus.topTerms", label: "Top terms", widget: "number" },
      { path: "corpus.profilePath", label: "Profile sidecar path", widget: "path", pathLike: true },
    ],
  },
  {
    id: "dot",
    title: "DOT export options",
    description: "Used when export format is dot.",
    fields: [
      { path: "export.dot.layout", label: "Layout", widget: "select" },
      { path: "export.dot.rankdir", label: "Rank direction", widget: "select" },
      { path: "export.dot.nodeShape", label: "Node shape", widget: "text" },
      { path: "export.dot.edgeStyle", label: "Edge style", widget: "text" },
      { path: "export.dot.colorScheme", label: "Color scheme", widget: "select" },
      { path: "export.dot.includeObservations", label: "Include observations", widget: "boolean" },
      { path: "export.dot.maxObservationsPerNode", label: "Max observations / node", widget: "number" },
      { path: "export.dot.clusterByEntityType", label: "Cluster by entity type", widget: "boolean" },
      { path: "export.dot.clusterByFile", label: "Cluster by file", widget: "boolean" },
      { path: "export.dot.showLegend", label: "Show legend", widget: "boolean" },
    ],
  },
  {
    id: "outline",
    title: "Document outline",
    fields: [
      { path: "readers.outline.enabled", label: "Enabled", widget: "boolean" },
      { path: "readers.outline.maxDepth", label: "Max depth", widget: "number", placeholder: "(no limit)" },
      { path: "readers.outline.includeLineNumbers", label: "Include line numbers", widget: "boolean" },
      { path: "readers.outline.includePrivate", label: "Include private members", widget: "boolean" },
      { path: "readers.outline.includeComments", label: "Include comments", widget: "boolean" },
      { path: "readers.outline.compact", label: "Compact (token-lean)", widget: "boolean" },
    ],
  },
  {
    id: "logging",
    title: "Logging & checkpoint",
    fields: [
      { path: "logging.level", label: "Log level", widget: "select" },
      { path: "logging.file", label: "Log file", widget: "path", pathLike: true },
      { path: "logging.debug", label: "Debug", widget: "boolean" },
      { path: "logging.silent", label: "Silent", widget: "boolean" },
      { path: "resume.checkpointPath", label: "Checkpoint path", widget: "path", pathLike: true, placeholder: "<output>.checkpoint.jsonl" },
    ],
  },
];

/** Paths the frontend owns and forces per web run — never imported or sent as-is. */
export const CONTROLLED_PATHS = ["resume.enabled", "logging.progressNdjson", "runtime.watch", "runtime.exportOnly"];
