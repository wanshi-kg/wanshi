/**
 * Resolve the final graph output path for an `output` stem + export `format`.
 *
 * The export writer rewrites the extension to match the chosen format
 * (`--output kg.json --export-format jsonl` → `kg.jsonl`). Sidecar paths
 * (trace, cost, checkpoint, …) must hang off this *resolved* path, not the raw
 * `--output` stem, or the artifacts split from the graph (KG-11 / WS-59).
 *
 * Pure + dependency-free so both `DirectoryProcessor` and `ContainerFactory`
 * derive sidecar paths from the same single source of truth. When the output
 * extension already matches the format the path is returned unchanged, so a
 * default run stays byte-identical.
 */
export function resolveOutputPath(originalPath: string, format: string): string {
  return originalPath.endsWith(`.${format}`)
    ? originalPath
    : originalPath.replace(/\.[^.]+$/, `.${format}`);
}
