import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ConfigSchema,
  ProviderModeEnum,
  ChunkingModeEnum,
  RetrievalModeEnum,
  RetrievalScopeEnum,
  SpeechRecognitionModeEnum,
  ImageProcessingModeEnum,
  ContentClassifierModeEnum,
  GroundingModeEnum,
  ExportFormatEnum,
} from "./schema";
import { formatConfigError } from "./legacyHints";
import { CONFIG_GROUPS, CONTROLLED_PATHS } from "./ui";

export { ConfigSchema } from "./schema";
export { LEGACY_KEY_HINTS, formatConfigError } from "./legacyHints";
export { CONFIG_GROUPS, CONTROLLED_PATHS } from "./ui";
export type { ConfigFieldMeta, ConfigGroupMeta, FieldWidget } from "./ui";

/** The fully-resolved config (all defaults applied). Single source of truth. */
export type ProcessingOptions = z.infer<typeof ConfigSchema>;

// Subtype aliases other modules import.
export type LLMProviderMode = z.infer<typeof ProviderModeEnum>;
export type ChunkingMode = z.infer<typeof ChunkingModeEnum>;
export type RetrievalMode = z.infer<typeof RetrievalModeEnum>;
export type RetrievalScope = z.infer<typeof RetrievalScopeEnum>;
export type SpeechRecognitionMode = z.infer<typeof SpeechRecognitionModeEnum>;
export type ImageProcessingMode = z.infer<typeof ImageProcessingModeEnum>;
export type ContentClassifierMode = z.infer<typeof ContentClassifierModeEnum>;
export type GroundingMode = z.infer<typeof GroundingModeEnum>;
export type ExportFormat = z.infer<typeof ExportFormatEnum>;
export type OutlineOptions = ProcessingOptions["readers"]["outline"];

// Canonicalization-experiment subtypes.
export type PipelineOptions = ProcessingOptions["pipeline"];
export type CanonicalizationOptions = ProcessingOptions["pipeline"]["canonicalization"];
export type PipelineGroundingOptions = ProcessingOptions["pipeline"]["grounding"];
export type InspectionOptions = ProcessingOptions["inspection"];
export type EvalOptions = ProcessingOptions["eval"];

/**
 * Validate a raw (merged) config object and apply all defaults. Throws a
 * `ConfigError` with an actionable message (legacy keys → new nested paths) on
 * a validation failure.
 */
export function parseConfig(raw: unknown): ProcessingOptions {
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(formatConfigError(result.error), result.error);
  }
  return result.data;
}

/** Error carrying a human-formatted config validation message. */
export class ConfigError extends Error {
  constructor(message: string, readonly cause?: z.ZodError) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The config JSON Schema (inlined, no $refs) for external consumers. */
export function configJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ConfigSchema, {
    name: "KgGenConfig",
    $refStrategy: "none",
  }) as Record<string, unknown>;
}

/**
 * The full schema payload the `kg-gen schema` command emits and the frontend
 * consumes: the JSON Schema (types/enums/defaults/help) plus UI layout metadata
 * (groups + widget hints) so the run form is rendered without duplicating it.
 */
export function configSchemaPayload(): {
  jsonSchema: Record<string, unknown>;
  groups: typeof CONFIG_GROUPS;
  controlledPaths: string[];
} {
  return {
    jsonSchema: configJsonSchema(),
    groups: CONFIG_GROUPS,
    controlledPaths: CONTROLLED_PATHS,
  };
}
