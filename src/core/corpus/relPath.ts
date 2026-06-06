import * as path from "path";

/**
 * Stable identity for a file: its path relative to the discovery root
 * (`options.input`), posix-normalized — so relocating the input tree doesn't
 * invalidate per-file caching. Mirrors `KnowledgeGraphBuilder.stablePathId`.
 * Falls back to the raw path when the file lies outside the root.
 */
export function toRelPathId(inputRoot: string, filePath: string): string {
  if (!inputRoot) return filePath;
  const rel = path.relative(inputRoot, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return rel.split(path.sep).join("/");
}
