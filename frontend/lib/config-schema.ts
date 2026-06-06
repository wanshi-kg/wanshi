import type { RunRequest } from "@/lib/kg-options"

/** Form value as stored in the flat `values` record. */
export type FieldValue = string | boolean

export type FieldType =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "lines"
  | "path"

export interface ConfigField {
  /** Dotted for nested groups, e.g. "dotOptions.layout". */
  key: string
  label: string
  type: FieldType
  options?: readonly string[]
  default?: FieldValue
  placeholder?: string
  help?: string
  required?: boolean
}

export interface ConfigGroup {
  id: string
  title: string
  description?: string
  defaultOpen?: boolean
  fields: ConfigField[]
}

/** Fields that map onto the typed RunRequest core; everything else is passthrough. */
export const CORE_KEYS = new Set([
  "input",
  "filter",
  "exclude",
  "provider",
  "model",
  "host",
  "apiKey",
  "output",
  "exportFormat",
  "chunkSize",
])

/** Path fields resolved to absolute on import (NOT `system` — it may be prompt text). */
export const PATH_KEYS = ["input", "output", "logFile", "checkpointPath"]

/** Keys the frontend controls itself — never imported or sent. */
const CONTROLLED = new Set(["resume", "progressNdjson", "config", "watch", "exportOnly"])

export const CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: "input",
    title: "Input",
    description: "Directory and file patterns to process.",
    defaultOpen: true,
    fields: [
      { key: "input", label: "Input directory", type: "path", required: true, placeholder: "/path/to/project" },
      { key: "filter", label: "Include patterns (one per line)", type: "lines", default: "**/*", required: true },
      { key: "exclude", label: "Exclude patterns (one per line)", type: "lines", default: "**/node_modules/**\n**/.git/**" },
      { key: "description", label: "Description", type: "text", placeholder: "short description for the LLM" },
    ],
  },
  {
    id: "generation",
    title: "Generation",
    description: "LLM provider and sampling.",
    defaultOpen: true,
    fields: [
      { key: "provider", label: "Provider", type: "select", options: ["ollama", "openai"], default: "ollama" },
      { key: "model", label: "Model", type: "text", default: "llama3.2", required: true },
      { key: "host", label: "Host / base URL", type: "text", default: "http://localhost:11434" },
      { key: "apiKey", label: "API key", type: "password", help: "OpenAI-compatible only; falls back to $OPENAI_API_KEY" },
      { key: "temperature", label: "Temperature", type: "number", default: "0.1" },
      { key: "repeatPenalty", label: "Repeat penalty (Ollama)", type: "number", default: "0.3" },
      { key: "contextLength", label: "Context length (Ollama)", type: "number", default: "8192" },
      { key: "maxTokens", label: "Max output tokens", type: "number", placeholder: "(provider default)" },
      { key: "seed", label: "Seed (Ollama)", type: "number", placeholder: "(none)" },
      { key: "system", label: "System prompt or template path", type: "text" },
      { key: "promptVersion", label: "Prompt version", type: "text", placeholder: "v4.5" },
    ],
  },
  {
    id: "output",
    title: "Output",
    description: "Where and how to write the graph.",
    defaultOpen: true,
    fields: [
      { key: "output", label: "Output file", type: "path", default: "knowledge-graph.json", required: true },
      { key: "exportFormat", label: "Export format", type: "select", options: ["json", "jsonl", "mcp-jsonl", "dot", "kblam", "lora", "graphiti"], default: "json" },
    ],
  },
  {
    id: "embeddings",
    title: "Embeddings",
    description: "Independent provider for dedup / retrieval.",
    fields: [
      { key: "embeddingsProvider", label: "Provider", type: "select", options: ["ollama", "openai"], default: "ollama" },
      { key: "embeddingsModel", label: "Model", type: "text", default: "mxbai-embed-large:335m" },
      { key: "embeddingsHost", label: "Host / base URL", type: "text", default: "http://localhost:11434" },
      { key: "embeddingsApiKey", label: "API key", type: "password" },
      { key: "embeddingsMaxInputChars", label: "Max input chars", type: "number", default: "1024" },
    ],
  },
  {
    id: "chunking",
    title: "Text & chunking",
    fields: [
      { key: "chunking", label: "Chunking", type: "select", options: ["enabled", "disabled", "auto"], default: "enabled" },
      { key: "chunkSize", label: "Chunk size (chars)", type: "number", default: "2000" },
      { key: "overlapSize", label: "Overlap size (chars)", type: "number", default: "100" },
    ],
  },
  {
    id: "media",
    title: "Media (images · ASR · documents)",
    fields: [
      { key: "images", label: "Images", type: "select", options: ["auto", "enabled", "disabled"], default: "auto" },
      { key: "asr", label: "Audio (ASR)", type: "select", options: ["enabled", "disabled", "auto"], default: "enabled" },
      { key: "whisperModel", label: "Whisper model", type: "text", default: "medium" },
      { key: "language", label: "Language", type: "text", default: "auto" },
      { key: "translate", label: "Translate to English", type: "boolean", default: false },
      { key: "docling", label: "Use Docling for PDF/Office", type: "boolean", default: false },
    ],
  },
  {
    id: "jsonReader",
    title: "JSON reader",
    fields: [
      { key: "jsonReader.strategy", label: "Strategy", type: "select", options: ["structural", "raw"], default: "structural" },
      { key: "jsonReader.maxChunkSize", label: "Max chunk size", type: "number", placeholder: "(inherits chunk size)" },
    ],
  },
  {
    id: "classifier",
    title: "Classifier (experimental)",
    fields: [
      { key: "classifier", label: "Classifier", type: "select", options: ["disabled", "heuristic", "llm", "bert"], default: "disabled" },
    ],
  },
  {
    id: "retrieval",
    title: "Retrieval",
    fields: [
      { key: "retrieval", label: "Retrieval", type: "select", options: ["enabled", "disabled", "auto"], default: "enabled" },
      { key: "retrievalLimit", label: "Limit", type: "number", default: "3" },
      { key: "retrievalScope", label: "Scope", type: "select", options: ["chunk", "file"], default: "chunk" },
    ],
  },
  {
    id: "grounding",
    title: "Grounding",
    fields: [
      { key: "grounding", label: "Grounding gate", type: "select", options: ["disabled", "flag", "drop"], default: "disabled" },
      { key: "groundingMinScore", label: "Min score", type: "number", default: "0.5" },
    ],
  },
  {
    id: "merging",
    title: "Merging",
    fields: [
      { key: "entitySimilarityThreshold", label: "Entity similarity threshold", type: "number", default: "0.9" },
      { key: "observationSimilarityThreshold", label: "Observation similarity threshold", type: "number", default: "0.9" },
      { key: "enableSimilarityMerging", label: "Enable similarity merging", type: "boolean", default: true },
    ],
  },
  {
    id: "dot",
    title: "DOT export options",
    description: "Used when export format is dot.",
    fields: [
      { key: "dotOptions.layout", label: "Layout", type: "select", options: ["dot", "neato", "fdp", "sfdp", "circo", "twopi"], default: "dot" },
      { key: "dotOptions.rankdir", label: "Rank direction", type: "select", options: ["TB", "BT", "LR", "RL"], default: "TB" },
      { key: "dotOptions.nodeShape", label: "Node shape", type: "text", default: "box" },
      { key: "dotOptions.edgeStyle", label: "Edge style", type: "text", default: "solid" },
      { key: "dotOptions.colorScheme", label: "Color scheme", type: "select", options: ["default", "scientific", "code", "minimal"], default: "default" },
      { key: "dotOptions.includeObservations", label: "Include observations", type: "boolean", default: true },
      { key: "dotOptions.maxObservationsPerNode", label: "Max observations / node", type: "number", default: "3" },
      { key: "dotOptions.clusterByEntityType", label: "Cluster by entity type", type: "boolean", default: false },
      { key: "dotOptions.clusterByFile", label: "Cluster by file", type: "boolean", default: false },
      { key: "dotOptions.showLegend", label: "Show legend", type: "boolean", default: true },
    ],
  },
  {
    id: "outline",
    title: "Document outline",
    fields: [
      { key: "outline.enabled", label: "Enabled", type: "boolean", default: true },
      { key: "outline.maxDepth", label: "Max depth", type: "number", placeholder: "(no limit)" },
      { key: "outline.includeLineNumbers", label: "Include line numbers", type: "boolean", default: false },
      { key: "outline.includePrivate", label: "Include private members", type: "boolean", default: false },
      { key: "outline.includeComments", label: "Include comments", type: "boolean", default: false },
    ],
  },
  {
    id: "logging",
    title: "Logging & checkpoint",
    fields: [
      { key: "logLevel", label: "Log level", type: "select", options: ["info", "debug", "warning", "error"], default: "info" },
      { key: "logFile", label: "Log file", type: "path" },
      { key: "debug", label: "Debug", type: "boolean", default: false },
      { key: "silent", label: "Silent", type: "boolean", default: false },
      { key: "checkpointPath", label: "Checkpoint path", type: "path", placeholder: "<output>.checkpoint.jsonl" },
    ],
  },
]

export const ALL_FIELDS: ConfigField[] = CONFIG_GROUPS.flatMap((g) => g.fields)

/** Initial flat values from the metadata defaults. */
export function buildDefaultValues(): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const f of ALL_FIELDS) {
    values[f.key] = f.default ?? (f.type === "boolean" ? false : "")
  }
  return values
}

/** Coerce a form value to its real type, or undefined to omit it from the config. */
function coerce(field: ConfigField, raw: FieldValue | undefined): unknown {
  if (field.type === "boolean") return Boolean(raw)
  const s = raw == null ? "" : String(raw)
  if (field.type === "number") {
    if (s.trim() === "") return undefined
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (field.type === "lines") {
    const arr = s.split("\n").map((x) => x.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }
  const t = s.trim()
  return t === "" ? undefined : t
}

/** Convert a parsed YAML/JSON value into the form's flat representation. */
function toFieldValue(field: ConfigField, val: unknown): FieldValue {
  if (field.type === "boolean") return Boolean(val)
  if (field.type === "lines") return Array.isArray(val) ? val.map(String).join("\n") : String(val)
  return String(val)
}

/**
 * Flatten a parsed config into the form's flat values (nested groups → dotted
 * keys), plus any unknown top-level keys to pass through untouched.
 */
export function flattenConfig(parsed: Record<string, unknown>): {
  values: Record<string, FieldValue>
  extra: Record<string, unknown>
} {
  const values: Record<string, FieldValue> = {}
  const knownTop = new Set<string>()
  for (const f of ALL_FIELDS) knownTop.add(f.key.includes(".") ? f.key.split(".")[0] : f.key)

  for (const f of ALL_FIELDS) {
    let val: unknown
    if (f.key.includes(".")) {
      const [g, sub] = f.key.split(".")
      const grp = parsed[g]
      val = grp && typeof grp === "object" ? (grp as Record<string, unknown>)[sub] : undefined
    } else {
      val = parsed[f.key]
    }
    if (val != null) values[f.key] = toFieldValue(f, val)
  }

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (!knownTop.has(k) && !CONTROLLED.has(k)) extra[k] = v
  }
  return { values, extra }
}

/**
 * Partition flat form values into the typed RunRequest core and the passthrough
 * config (nested groups reassembled), merging any imported unknown fields.
 */
export function partitionValues(
  values: Record<string, FieldValue>,
  extra: Record<string, unknown> = {}
): { req: RunRequest; passthrough?: Record<string, unknown> } {
  const req: Record<string, unknown> = {}
  const passthrough: Record<string, unknown> = { ...extra }

  for (const f of ALL_FIELDS) {
    const v = coerce(f, values[f.key])
    if (v === undefined) continue
    if (CORE_KEYS.has(f.key)) {
      req[f.key] = v
    } else if (f.key.includes(".")) {
      const [g, sub] = f.key.split(".")
      const grp =
        passthrough[g] && typeof passthrough[g] === "object"
          ? (passthrough[g] as Record<string, unknown>)
          : ((passthrough[g] = {}) as Record<string, unknown>)
      grp[sub] = v
    } else {
      passthrough[f.key] = v
    }
  }

  return {
    req: req as RunRequest,
    passthrough: Object.keys(passthrough).length ? passthrough : undefined,
  }
}
