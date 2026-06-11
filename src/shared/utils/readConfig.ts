import yaml from 'js-yaml';
import path from "path";
import fs from "fs";

/**
 * Read a YAML/JSON config file into a raw object. No validation or shaping here
 * — the caller merges this with CLI flags + env and validates the result via
 * `parseConfig` (src/config), the single source of truth.
 */
export async function readConfigurationFile(
  file: string
): Promise<Record<string, unknown>> {
  const ext = path.extname(file);
  const content = fs.readFileSync(file, "utf-8");
  switch (ext.toLowerCase()) {
    case ".json":
      return JSON.parse(content) as Record<string, unknown>;

    case ".yaml":
    case ".yml":
      return (yaml.load(content) as Record<string, unknown>) ?? {};

    default:
      // Fail loud: returning {} silently ran the whole pipeline on pure
      // defaults (ignoring the user's config entirely) — KG-18.
      throw new Error(
        `Unsupported config file extension "${ext}" for ${file}; use .json, .yaml, or .yml`
      );
  }
}
