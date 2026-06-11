import { z } from "zod";

/**
 * The single source of truth for kg-gen's configuration.
 *
 * Everything else is derived from this schema: the `ProcessingOptions` TS type
 * (`z.infer`), runtime validation + defaults (`parseConfig`), and the JSON
 * Schema served to the frontend (`configJsonSchema`). Defaults live here and
 * nowhere else — CLI flags carry no defaults, and services no longer apply
 * scattered `?? fallback`s.
 *
 * Objects are `.strict()` so an unknown/legacy flat key (e.g. `chunkSize`) is a
 * hard error with a migration hint, not a silent miscast (clean break from the
 * old flat shape — see docs/MIGRATION.md).
 *
 * Numeric fields use `z.coerce.number()` so CLI string values ("2000") and YAML
 * numbers both validate. `.default()` short-circuits `undefined` before
 * coercion, so an unset flag falls through to the default rather than NaN.
 */

// ── small helpers ──────────────────────────────────────────────────────────

/** A number field with a default; coerces CLI strings + YAML numbers. */
const num = (def: number) => z.coerce.number().default(def);

/** Accept a single string or an array of strings; normalize to an array. */
const stringList = (def: string[]) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .default(def);

// ── enums (reused as exported subtypes) ────────────────────────────────────

export const ProviderModeEnum = z.enum(["ollama", "openai"]);
export const ChunkingModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const RetrievalModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const RetrievalScopeEnum = z.enum(["chunk", "file"]);
export const SpeechRecognitionModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const ImageProcessingModeEnum = z.enum(["enabled", "disabled", "auto"]);
export const ContentClassifierModeEnum = z.enum([
  "disabled",
  "heuristic",
  "llm",
  "bert",
]);
export const GroundingModeEnum = z.enum(["disabled", "flag", "drop"]);
export const CorpusProfilingModeEnum = z.enum(["disabled", "enabled"]);
export const ExportFormatEnum = z.enum([
  "json",
  "jsonl",
  "mcp-jsonl",
  "dot",
  "kblam",
  "lora",
  "graphiti",
]);
export const JsonStrategyEnum = z.enum(["structural", "raw"]);
export const LogLevelEnum = z.enum(["debug", "info", "warning", "error"]);

// ── grouped sub-schemas ────────────────────────────────────────────────────

const LlmSchema = z
  .object({
    provider: ProviderModeEnum.default("ollama").describe(
      "Generation provider. 'openai' targets any OpenAI-compatible endpoint via host."
    ),
    model: z.string().default("llama3.2").describe("LLM used for generation"),
    host: z
      .string()
      .default("http://localhost:11434")
      .describe("Ollama host URL, or OpenAI-compatible base URL when provider=openai"),
    apiKey: z
      .string()
      .optional()
      .describe("API key for OpenAI-compatible provider (falls back to $OPENAI_API_KEY / $KG_API_KEY)"),
    temperature: num(0.1).describe("Model temperature"),
    repeatPenalty: num(0.3).describe("Repeat penalty (higher → more diverse output)"),
    contextLength: num(8192).describe("Model context length (system prompt + chunk + response)"),
    maxTokens: z.coerce
      .number()
      .optional()
      .describe("Max output tokens per generation; raise it if KG JSON truncates mid-output"),
    seed: z.coerce.number().optional().describe("Model seed"),
    system: z.string().optional().describe("System prompt text or path to a handlebars template"),
    promptVersion: z
      .string()
      .default("v5")
      .describe("Prompt template version under templates/ (v5 default; v4.5 = legacy)"),
  })
  .strict();

const EmbeddingsSchema = z
  .object({
    provider: ProviderModeEnum.default("ollama").describe(
      "Embeddings provider, independent from generation; defaults to local Ollama"
    ),
    model: z.string().default("mxbai-embed-large:335m").describe("Embeddings model"),
    host: z.string().default("http://localhost:11434").describe("Embeddings host / OpenAI-compatible base URL"),
    apiKey: z.string().optional().describe("API key for OpenAI-compatible embeddings"),
    maxInputChars: num(1024).describe("Truncate embedding inputs to at most N characters"),
  })
  .strict();

const ChunkingSchema = z
  .object({
    mode: ChunkingModeEnum.default("enabled").describe("Chunking mode"),
    size: num(2000).describe("Maximum chunk size in characters"),
    overlap: num(100).describe("Overlap size between chunks in characters"),
  })
  .strict();

const RetrievalSchema = z
  .object({
    mode: RetrievalModeEnum.default("enabled").describe("Context retrieval mode"),
    limit: num(3).describe("Context retrieval limit"),
    scope: RetrievalScopeEnum.default("chunk").describe(
      "Retrieval granularity: per-chunk (default) or once per file"
    ),
  })
  .strict();

const MergingSchema = z
  .object({
    entitySimilarityThreshold: num(0.9).describe("Jaro-Winkler threshold for entity-name merging, applied uniformly within-file and globally; fuzzy merging never crosses a digit mismatch (Table 1 ≠ Table 2) and cross-type matches need near-exact similarity"),
    observationSimilarityThreshold: num(0.9).describe("Embedding cosine threshold for observation merging"),
    enableSimilarityMerging: z.boolean().default(true).describe("Allow fuzzy (Jaro-Winkler) entity-name merging; false ⇒ only normalized-exact name matches merge"),
  })
  .strict();

const GroundingSchema = z
  .object({
    mode: GroundingModeEnum.default("disabled").describe(
      "Inline grounding gate: disabled | flag (annotate) | drop (remove ungrounded)"
    ),
    minScore: num(0.5).describe("Minimum keyword-overlap grounding score (0..1)"),
  })
  .strict();

const CorpusSchema = z
  .object({
    profiling: CorpusProfilingModeEnum.default("disabled").describe(
      "Corpus analysis pre-pass: term frequency + cached classification + LLM glossary"
    ),
    topTerms: num(100).describe("Number of most-frequent terms fed to the glossary call"),
    profilePath: z.string().optional().describe("Corpus profile sidecar path (default <output>.corpus-profile.json)"),
    clustering: z.boolean().default(false).describe("Embedding clustering of terms (v2 stub, deferred)"),
  })
  .strict();

const ClassifierSchema = z
  .object({
    mode: ContentClassifierModeEnum.default("disabled").describe("Content classifier mode (experimental)"),
  })
  .strict();

const JsonReaderSchema = z
  .object({
    strategy: JsonStrategyEnum.default("structural").describe(
      "JSON reader: structural (split on JSON structure) or raw (text split)"
    ),
    maxChunkSize: z.coerce.number().optional().describe("Max JSON chunk size (inherits chunking.size when unset)"),
  })
  .strict();

const AsrSchema = z
  .object({
    mode: SpeechRecognitionModeEnum.default("enabled").describe("Automatic speech recognition mode"),
    whisperModel: z.string().default("medium").describe("Whisper model"),
    language: z.string().default("auto").describe("Speech recognition language"),
    translate: z.boolean().default(false).describe("Translate transcript to English"),
  })
  .strict();

const OutlineSchema = z
  .object({
    enabled: z.boolean().default(true).describe("Generate a per-file structural outline and inject it into the prompt"),
    maxDepth: z.coerce.number().optional().describe("Limit outline nesting depth"),
    includeLineNumbers: z.boolean().default(false).describe("Include line numbers in the outline"),
    includePrivate: z.boolean().default(false).describe("Include private/internal members"),
    includeComments: z.boolean().default(false).describe("Include comments"),
  })
  .strict();

const ReadersSchema = z
  .object({
    docling: z.boolean().default(false).describe("Use Docling for PDF/DOC/DOCX/PPT/PPTX"),
    stripReferences: z.boolean().default(false).describe("Quarantine trailing references/bibliography sections before extraction (PDF + markdown)"),
    images: ImageProcessingModeEnum.default("auto").describe("Image processing mode"),
    json: JsonReaderSchema.default({}),
    asr: AsrSchema.default({}),
    outline: OutlineSchema.default({}),
  })
  .strict();

const DotSchema = z
  .object({
    layout: z.enum(["dot", "neato", "fdp", "sfdp", "circo", "twopi"]).default("dot"),
    rankdir: z.enum(["TB", "BT", "LR", "RL"]).default("TB"),
    nodeShape: z.string().default("box"),
    edgeStyle: z.string().default("solid"),
    colorScheme: z.enum(["default", "scientific", "code", "minimal"]).default("default"),
    includeObservations: z.boolean().default(true),
    maxObservationsPerNode: num(3),
    clusterByEntityType: z.boolean().default(false),
    clusterByFile: z.boolean().default(false),
    showLegend: z.boolean().default(true),
  })
  .strict();

const ExportSchema = z
  .object({
    format: ExportFormatEnum.default("json").describe("Export format"),
    dot: DotSchema.default({}).describe("DOT export options (used when format=dot)"),
  })
  .strict();

const ResumeSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Checkpoint each chunk and skip already-done chunks on re-run"),
    checkpointPath: z.string().optional().describe("Checkpoint sidecar file path (default <output>.checkpoint.jsonl)"),
  })
  .strict();

const LoggingSchema = z
  .object({
    level: LogLevelEnum.default("info").describe("Log level"),
    file: z.string().optional().describe("Log file path"),
    debug: z.boolean().default(false).describe("Debug mode"),
    silent: z.boolean().default(false).describe("Silent mode"),
    progressNdjson: z
      .boolean()
      .default(false)
      .describe("Emit structured NDJSON progress events on stdout (suppresses pretty logging)"),
  })
  .strict();

const RuntimeSchema = z
  .object({
    watch: z.boolean().default(false).describe("Watch for changes and rebuild the graph"),
    exportOnly: z.boolean().default(false).describe("Convert an existing graph JSON (input) to export.format"),
  })
  .strict();

// ── pipeline stages (canonicalization experiment) ──────────────────────────
//
// Explicit, reorderable, enable/disable stages (canon brief §3/§4). For
// Experiment 1 the producer stages (tf_analysis / schema_induction /
// extraction) run in fixed relative order and gate existing behavior; the
// genuinely reorderable part is the post-extraction graph→graph transforms
// (grounding, canonicalization), which is the seam Experiment 2 needs.

export const TfAnalysisSourceEnum = z.enum(["corpus", "graph"]);
export const CanonMethodEnum = z.enum(["embeddings", "llm", "hybrid"]);
export const ClusterAlgoEnum = z.enum(["agglomerative", "hdbscan", "kmeans"]);
export const CanonicalSelectionEnum = z.enum(["frequency", "degree"]);
export const CanonTargetEnum = z.enum(["entities", "relations"]);

const DEFAULT_STAGES = [
  "tf_analysis",
  "schema_induction",
  "extraction",
  "grounding",
  "canonicalization",
];

const StageToggleSchema = z
  .object({ enabled: z.boolean().default(true) })
  .strict();

const TfAnalysisStageSchema = z
  .object({
    enabled: z.boolean().default(true),
    source: TfAnalysisSourceEnum.default("corpus").describe(
      "Term-frequency source: 'corpus' (lexical, Exp 1) | 'graph' (structural salience, Exp 2 — stat collection only)"
    ),
  })
  .strict();

// NOTE: distinct from the top-level `grounding` group (the inline *observation*
// grounding gate). This is the *edge* co-occurrence gate — OFF for Experiment 1,
// the precision gate Experiment 2 runs before canonicalization.
const PipelineGroundingSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Edge co-occurrence grounding gate (OFF for Exp 1)"),
    requireCooccurrence: z
      .boolean()
      .default(true)
      .describe("Drop edges whose endpoints don't co-occur in their source span"),
  })
  .strict();

const CanonClusterSchema = (threshold: number) =>
  z
    .object({
      cluster: ClusterAlgoEnum.default("agglomerative").describe(
        "Clustering algorithm (only 'agglomerative' is implemented)"
      ),
      threshold: num(threshold).describe("Cosine-similarity merge threshold"),
      k: z.coerce.number().nullable().default(null).describe("Cluster count (only for kmeans)"),
    })
    .strict();

const simBand = () =>
  z
    .tuple([z.coerce.number(), z.coerce.number()])
    .describe("Similarity band [low, high] considered borderline");

const CanonicalizationSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Global embedding-clustering canonicalization pass (after merge)"),
    target: z
      .array(CanonTargetEnum)
      .default(["entities", "relations"])
      .describe("Canonicalize entity names/types, edge labels, or both"),
    method: CanonMethodEnum.default("embeddings").describe(
      "embeddings (cluster) | llm (adjudicate) | hybrid (cluster + escalate borderline)"
    ),
    canonicalSelection: CanonicalSelectionEnum.default("frequency").describe(
      "Pick the cluster's canonical representative by frequency or graph degree"
    ),
    embeddings: z
      .object({
        entity: CanonClusterSchema(0.82).default({}),
        relation: CanonClusterSchema(0.85).default({}),
      })
      .strict()
      .default({}),
    llm: z
      .object({
        model: z.string().optional().describe("Adjudication model (defaults to llm.model)"),
        adjudicate: z.enum(["borderline_only"]).default("borderline_only"),
        band: simBand().default([0.72, 0.88]),
      })
      .strict()
      .default({}),
    hybrid: z
      .object({
        escalateBand: simBand().default([0.72, 0.88]),
      })
      .strict()
      .default({}),
  })
  .strict();

const PipelineRelationFilterSchema = z
  .object({
    // `related_to` is the relation layer's catch-all (NR-4): on the telegram-sink corpus
    // ~30% of edges. This post-canon gate prunes the low-value subset. `redundant` drops
    // a `related_to` edge only when the same unordered endpoint pair already carries a
    // typed edge (safe — no information lost). `all` drops every `related_to` edge (for
    // consumers wanting only typed relations). Re-typing (LLM pass) is a future option.
    mode: z
      .enum(["off", "redundant", "all"])
      .default("off")
      .describe("related_to pruning: off | redundant (drop when a typed twin exists) | all"),
  })
  .strict();

const PipelineSchema = z
  .object({
    stages: z
      .array(z.string())
      .default(DEFAULT_STAGES)
      .describe("Ordered stage list; reorder for Experiment 2 (typeless-first)"),
    tfAnalysis: TfAnalysisStageSchema.default({}),
    schemaInduction: StageToggleSchema.default({}),
    extraction: StageToggleSchema.default({}),
    grounding: PipelineGroundingSchema.default({}),
    canonicalization: CanonicalizationSchema.default({}),
    relationFilter: PipelineRelationFilterSchema.default({}),
  })
  .strict();

const InspectionSchema = z
  .object({
    emitMergeLog: z.boolean().default(false).describe("Write the per-cluster canonicalization merge log"),
    mergeLogPath: z
      .string()
      .optional()
      .describe("Merge-log path (default runs/<run_id>/merges.jsonl)"),
  })
  .strict();

const EvalSchema = z
  .object({
    seed: z.coerce.number().optional().describe("Experiment seed (recorded in the run manifest)"),
    groundTruth: z.string().optional().describe("Ground-truth facts JSONL for scoring"),
    pinVersions: z
      .boolean()
      .default(true)
      .describe("Pin model/embedding/seed versions in the run manifest"),
  })
  .strict();

// ── root schema ────────────────────────────────────────────────────────────

export const ConfigSchema = z
  .object({
    // Core run essentials stay top-level.
    input: z.string().default(".").describe("Input directory (or existing graph file in export-only mode)"),
    filter: stringList(["**/*"]).describe("Include files by glob (string or list)"),
    exclude: stringList([]).describe("Exclude files by glob (string or list)"),
    output: z.string().default("knowledge-graph.json").describe("Output knowledge graph file"),
    description: z.string().default("").describe("Short description of the corpus for the LLM"),

    // Grouped by concern.
    llm: LlmSchema.default({}),
    embeddings: EmbeddingsSchema.default({}),
    chunking: ChunkingSchema.default({}),
    retrieval: RetrievalSchema.default({}),
    merging: MergingSchema.default({}),
    grounding: GroundingSchema.default({}),
    corpus: CorpusSchema.default({}),
    classifier: ClassifierSchema.default({}),
    readers: ReadersSchema.default({}),
    export: ExportSchema.default({}),
    resume: ResumeSchema.default({}),
    logging: LoggingSchema.default({}),
    runtime: RuntimeSchema.default({}),

    // Canonicalization experiment (canon brief). Config-only (no CLI flags).
    pipeline: PipelineSchema.default({}),
    inspection: InspectionSchema.default({}),
    eval: EvalSchema.default({}),
  })
  .strict();
