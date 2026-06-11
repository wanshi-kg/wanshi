import * as fs from "fs";
import * as path from "path";

/** Build a filesystem-safe slug from an arbitrary title/url. */
export function slugify(input: string, max = 48): string {
  const s = input
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s || "item";
}

/** UTC timestamp prefix, sortable + collision-resistant, e.g. 20260609-143501-123. */
function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..+/, (m) => "-" + m.slice(1, 4));
}

export interface ProvenanceHeader {
  source?: string; // URL or origin
  kind: string;
  title?: string;
}

/**
 * Write a markdown content file into the inbox with a small provenance header so
 * kg-gen's readers see clean text and the extracted graph keeps an origin.
 * Returns the absolute path written.
 */
export function writeMarkdown(
  inboxDir: string,
  header: ProvenanceHeader,
  body: string,
  slugSeed?: string
): string {
  const slug = slugify(slugSeed || header.title || header.source || header.kind);
  const file = path.join(inboxDir, `${stamp()}-${slug}.md`);
  const fetchedAt = new Date().toISOString();

  const frontmatter = [
    `# ${header.title ?? header.kind}`,
    "",
    `> source: ${header.source ?? "telegram"}`,
    `> kind: ${header.kind}`,
    `> fetchedAt: ${fetchedAt}`,
    "",
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(file, frontmatter + body.trim() + "\n", "utf-8");
  return file;
}

/** Absolute path for a downloaded binary, timestamped to avoid collisions. */
export function inboxBinaryPath(inboxDir: string, suggestedName: string): string {
  const ext = path.extname(suggestedName) || "";
  const base = slugify(path.basename(suggestedName, ext)) || "file";
  return path.join(inboxDir, `${stamp()}-${base}${ext}`);
}
