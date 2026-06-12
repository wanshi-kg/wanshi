/**
 * Translate Commander's flat, camelCase CLI options into the nested config shape
 * (`src/config/schema.ts`). CLI flags stay flat and ergonomic (`--chunk-size`,
 * not `--chunking.size`); this maps them onto their nested home so the schema —
 * the single source of truth — validates and defaults everything.
 *
 * CLI flags carry NO Commander defaults (see cli/index.ts): an unset flag is
 * absent here, so it never clobbers a file-config value. That makes precedence
 * defaults < file < CLI < env work as a plain deep merge.
 */

/** camelCase CLI option key → dotted path in the nested config. */
export const FLAG_TO_PATH: Record<string, string> = {
  input: "input",
  filter: "filter",
  exclude: "exclude",
  output: "output",
  description: "description",
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
  // readers
  asr: "readers.asr.mode",
  whisperModel: "readers.asr.whisperModel",
  language: "readers.asr.language",
  translate: "readers.asr.translate",
  docling: "readers.docling",
  stripReferences: "readers.stripReferences",
  jsonStrategy: "readers.json.strategy",
  images: "readers.images",
  // classifier
  classifier: "classifier.mode",
  // retrieval
  retrieval: "retrieval.mode",
  retrievalLimit: "retrieval.limit",
  retrievalScope: "retrieval.scope",
  // grounding
  grounding: "grounding.mode",
  groundingMinScore: "grounding.minScore",
  groundingChecker: "grounding.checker",
  groundingModel: "grounding.model",
  // corpus
  corpusProfiling: "corpus.profiling",
  corpusTopTerms: "corpus.topTerms",
  corpusProfilePath: "corpus.profilePath",
  // merging
  entitySimilarityThreshold: "merging.entitySimilarityThreshold",
  observationSimilarityThreshold: "merging.observationSimilarityThreshold",
  enableSimilarityMerging: "merging.enableSimilarityMerging",
  supersession: "merging.supersession",
  // export
  exportFormat: "export.format",
  // logging
  logLevel: "logging.level",
  logFile: "logging.file",
  debug: "logging.debug",
  silent: "logging.silent",
  progressNdjson: "logging.progressNdjson",
  // resume
  resume: "resume.enabled",
  checkpoint: "resume.checkpointPath",
  // runtime
  watch: "runtime.watch",
  exportOnly: "runtime.exportOnly",
};

/** Set a dotted path on a nested object, creating intermediate objects. */
export function setPath(target: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
}

/** Build a nested config partial from Commander's flat options (defined keys only). */
export function cliArgsToConfig(cliOptions: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [flag, path] of Object.entries(FLAG_TO_PATH)) {
    const value = cliOptions[flag];
    if (value !== undefined) setPath(out, path, value);
  }
  return out;
}

/** Recursively merge `override` onto `base` (plain objects deep-merged, arrays/scalars replaced). */
export function deepMerge(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
