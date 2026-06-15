import { ZodError } from "zod";

/**
 * Map of legacy flat config keys → their new nested path, so a clean-break
 * validation error can tell the user exactly where the key moved. Covers the
 * pre-nesting flat shape (see docs/MIGRATION.md). Keys not listed here are reported
 * as plain "unknown key".
 */
export const LEGACY_KEY_HINTS: Record<string, string> = {
  // llm
  provider: "llm.provider",
  model: "llm.model",
  host: "llm.host",
  apiKey: "llm.apiKey",
  temperature: "llm.temperature",
  repeatPenalty: "llm.repeatPenalty",
  contextLength: "llm.contextLength",
  maxTokens: "llm.maxTokens",
  seed: "llm.seed",
  system: "llm.system",
  promptVersion: "llm.promptVersion",
  // embeddings
  embeddingsProvider: "embeddings.provider",
  embeddingsModel: "embeddings.model",
  embeddingsHost: "embeddings.host",
  embeddingsApiKey: "embeddings.apiKey",
  embeddingsMaxInputChars: "embeddings.maxInputChars",
  // chunking
  chunking: "chunking.mode",
  chunkSize: "chunking.size",
  overlapSize: "chunking.overlap",
  // retrieval
  retrieval: "retrieval.mode",
  retrievalLimit: "retrieval.limit",
  retrievalScope: "retrieval.scope",
  // merging
  entitySimilarityThreshold: "merging.entitySimilarityThreshold",
  observationSimilarityThreshold: "merging.observationSimilarityThreshold",
  enableSimilarityMerging: "merging.enableSimilarityMerging",
  // grounding
  grounding: "grounding.mode",
  groundingMinScore: "grounding.minScore",
  // corpus
  corpusProfiling: "corpus.profiling",
  corpusTopTerms: "corpus.topTerms",
  corpusProfilePath: "corpus.profilePath",
  corpusClustering: "corpus.clustering",
  // classifier
  classifier: "classifier.mode",
  // readers
  docling: "readers.pdfEngine: docling",
  pdfEngine: "readers.pdfEngine",
  images: "readers.images",
  jsonStrategy: "readers.json.strategy",
  jsonReader: "readers.json",
  asr: "readers.asr.mode",
  whisperModel: "readers.asr.whisperModel",
  language: "readers.asr.language",
  translate: "readers.asr.translate",
  outline: "readers.outline",
  // export
  exportFormat: "export.format",
  dotOptions: "export.dot",
  // resume
  resume: "resume.enabled",
  checkpointPath: "resume.checkpointPath",
  // logging
  logLevel: "logging.level",
  logFile: "logging.file",
  debug: "logging.debug",
  silent: "logging.silent",
  progressNdjson: "logging.progressNdjson",
  // runtime
  watch: "runtime.watch",
  exportOnly: "runtime.exportOnly",
};

/**
 * Render a ZodError from `parseConfig` into an actionable message. Unrecognized
 * keys (the common symptom of a legacy flat config) are listed with their new
 * nested location; everything else is shown as a normal validation problem.
 */
export function formatConfigError(error: ZodError): string {
  const lines: string[] = ["Invalid configuration:"];
  const moved: string[] = [];
  const other: string[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const hint = LEGACY_KEY_HINTS[key];
        moved.push(
          hint
            ? `  • '${key}' → '${hint}' (the config format is now nested)`
            : `  • unknown key '${key}'`
        );
      }
    } else {
      const path = issue.path.join(".") || "(root)";
      other.push(`  • ${path}: ${issue.message}`);
    }
  }

  if (moved.length) {
    lines.push("", "Keys that moved (flat → nested):", ...moved);
  }
  if (other.length) {
    lines.push("", "Validation problems:", ...other);
  }
  if (moved.length) {
    lines.push("", "See docs/MIGRATION.md for the full flat → nested mapping.");
  }
  return lines.join("\n");
}
