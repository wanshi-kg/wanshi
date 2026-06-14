import YAML from "yaml"
import {
  valuesToConfig,
  secretFieldKeys,
  setPath,
  type FieldValue,
  type SchemaPayload,
} from "@/lib/config-schema"

/**
 * Build a wanshi config object from the form values — the nested shape the CLI
 * reads via `--config`. API keys are stripped (don't bake secrets into a
 * shareable file); the frontend-internal resume/progressNdjson flags aren't
 * added here either (they're applied only when launching a run).
 */
export function buildExportConfig(
  values: Record<string, FieldValue>,
  payload: SchemaPayload
): Record<string, unknown> {
  const config = valuesToConfig(values, payload)
  for (const secret of secretFieldKeys(payload)) {
    setPath(config, secret, undefined)
  }
  return pruneUndefined(config)
}

export function configToYaml(
  values: Record<string, FieldValue>,
  payload: SchemaPayload
): string {
  return YAML.stringify(buildExportConfig(values, payload))
}

/** Recursively drop undefined leaves (and the empty objects they leave behind). */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) {
      delete obj[k]
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      pruneUndefined(v as Record<string, unknown>)
      if (Object.keys(v as Record<string, unknown>).length === 0) delete obj[k]
    }
  }
  return obj
}
