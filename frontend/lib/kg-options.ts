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
  exportFormat: z
    .enum(["json", "jsonl", "mcp-jsonl", "dot", "kblam", "lora", "graphiti"])
    .default("json"),
  chunkSize: z.number().int().positive().default(2000),
})

export type RunRequest = z.infer<typeof RunRequestSchema>

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

