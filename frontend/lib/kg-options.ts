import { setPath } from "@/lib/config-schema"

/**
 * The nested wanshi config object (the shape the CLI validates via its Zod
 * schema and reads through `--config`). The frontend builds it from the form
 * (`valuesToConfig`) or imports it from a YAML/JSON file; it is no longer a
 * hand-maintained subset — the schema is the single source of truth.
 */
export type KgGenConfig = Record<string, unknown>

/**
 * Prepare a config for a web run. Web runs **always** checkpoint
 * (`resume.enabled`) so any run can be continued, and force `progressNdjson` for
 * the live stream. `output` is set to an absolute path by the run registry.
 * Returns a clone — the caller's config is not mutated.
 */
export function buildKgConfig(config: KgGenConfig): KgGenConfig {
  const out: KgGenConfig = structuredClone(config)
  setPath(out, "resume.enabled", true)
  setPath(out, "logging.progressNdjson", true)
  return out
}
