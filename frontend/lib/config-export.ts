import YAML from "yaml"
import { partitionValues, type FieldValue } from "@/lib/config-schema"

/**
 * Build a kg-gen config object from the form values — the same nested shape the
 * CLI reads via `--config` (core fields + nested dotOptions/outline/jsonReader).
 * API keys are stripped (don't bake secrets into a shareable file); the
 * frontend-internal resume/progressNdjson flags aren't included either.
 */
export function buildExportConfig(
  values: Record<string, FieldValue>,
  importExtra: Record<string, unknown> = {}
): Record<string, unknown> {
  const { req, passthrough } = partitionValues(values, importExtra)
  const config: Record<string, unknown> = { ...(passthrough ?? {}), ...req }
  delete config.apiKey
  delete config.embeddingsApiKey
  return config
}

export function configToYaml(
  values: Record<string, FieldValue>,
  importExtra: Record<string, unknown> = {}
): string {
  return YAML.stringify(buildExportConfig(values, importExtra))
}
