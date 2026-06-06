import { z } from "zod"

/**
 * The user-facing subset of kg-gen's ProcessingOptions that the run form
 * collects. Any other field (embeddings, retrieval, classifier, dotOptions, …)
 * rides along as `passthrough` so imported configs keep full fidelity.
 */
export const RunRequestSchema = z.object({
  input: z.string().min(1, "Input directory is required"),
  filter: z.array(z.string().min(1)).min(1, "At least one include pattern"),
  exclude: z.array(z.string().min(1)).default([]),
  provider: z.enum(["ollama", "openai"]).default("ollama"),
  model: z.string().min(1, "Model is required"),
  host: z.string().min(1),
  apiKey: z.string().optional(),
  output: z.string().min(1),
  exportFormat: z.enum(["json", "jsonl", "mcp-jsonl", "dot"]).default("json"),
  chunkSize: z.number().int().positive().default(2000),
})

export type RunRequest = z.infer<typeof RunRequestSchema>

/** Known form keys — these are pulled out of an imported config; the rest pass through. */
const KNOWN_KEYS = [
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
] as const

/** Config keys the frontend controls itself (never imported / passed through). */
const CONTROLLED_KEYS = new Set(["resume", "progressNdjson", "config", "watch", "exportOnly"])

/**
 * Map a validated request (+ optional passthrough config) onto the JSON config
 * the kg-gen CLI consumes via `--config`. `filter`/`exclude` MUST be arrays (the
 * CLI breaks on a bare string). Web runs **always** checkpoint (`resume: true`)
 * so any run can be continued; `progressNdjson` is forced for the live stream.
 * Known fields win over passthrough.
 */
export function buildKgConfig(
  req: RunRequest,
  passthrough: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...passthrough,
    input: req.input,
    filter: req.filter,
    exclude: req.exclude,
    provider: req.provider,
    model: req.model,
    host: req.host,
    ...(req.apiKey ? { apiKey: req.apiKey } : {}),
    output: req.output,
    exportFormat: req.exportFormat,
    chunkSize: req.chunkSize,
    resume: true,
    progressNdjson: true,
  }
}

/**
 * Split a parsed YAML/JSON config into the form's known fields and the rest
 * (passthrough), with light coercion so arrays/numbers land in the right shape.
 */
export function splitImportedConfig(parsed: Record<string, unknown>): {
  known: Partial<RunRequest>
  passthrough: Record<string, unknown>
} {
  const known: Partial<RunRequest> = {}
  const passthrough: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (value == null || CONTROLLED_KEYS.has(key)) continue
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      passthrough[key] = value
      continue
    }
    if (key === "filter" || key === "exclude") {
      known[key] = Array.isArray(value) ? value.map(String) : [String(value)]
    } else if (key === "chunkSize") {
      known.chunkSize = Number(value) || undefined
    } else {
      // input/model/host/output/provider/apiKey/exportFormat — strings
      ;(known as Record<string, unknown>)[key] = String(value)
    }
  }

  return { known, passthrough }
}

export const DEFAULT_RUN_REQUEST: RunRequest = {
  input: "",
  filter: ["**/*"],
  exclude: ["**/node_modules/**", "**/.git/**"],
  provider: "ollama",
  model: "llama3.2",
  host: "http://localhost:11434",
  output: "knowledge-graph.json",
  exportFormat: "json",
  chunkSize: 2000,
}
