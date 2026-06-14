/**
 * Reader-side raw reference extraction (Phase 0, network-free).
 *
 * Pure functions that pull the *references a document already contains* out of
 * its source text — internal links (markdown `[t](u)`, `[[wikilinks]]`, HTML
 * `href`) and citations (a trailing bibliography block + inline arXiv/DOI/PMID).
 * Nothing here resolves or fetches: readers stash the raw result on
 * `metadata.references` and the corpus-level `ReferenceResolver` turns it into
 * `links_to` / `cites` edges once the full file set is known.
 *
 * Citation parsing is hybrid: Citation.js handles structured BibTeX/`.bib`
 * blocks; a regex fallback handles prose bibliographies (the common case) and
 * inline ids. Citation.js throwing on prose is expected and caught.
 */

// Citation.js ships no type declarations and we use a thin slice of it, so it's
// required lazily (only when a BibTeX-looking block is parsed → zero cost on the
// prose/no-citation path) and typed locally. A plain `require` also keeps this
// resolvable under both `tsc` and a `ts-node` sandbox run without an ambient
// .d.ts on the include path.
interface CslEntry {
  type?: string;
  title?: string;
  DOI?: string;
  [key: string]: unknown;
}
type CiteCtor = new (data: unknown) => { data: CslEntry[] };

let citeCtor: CiteCtor | null | undefined;
function loadCite(): CiteCtor | null {
  if (citeCtor !== undefined) return citeCtor;
  try {
    const core = require("@citation-js/core") as { Cite: CiteCtor };
    require("@citation-js/plugin-bibtex"); // side-effect: registers the @biblatex input
    citeCtor = core.Cite;
  } catch {
    citeCtor = null;
  }
  return citeCtor;
}

export type LinkKind = "markdown" | "wikilink" | "html" | "url";

export interface RawLink {
  /** Target exactly as written (href / link destination), pre-resolution. */
  target: string;
  /** Link/anchor text, when present. */
  text?: string;
  kind: LinkKind;
}

export interface RawCitation {
  /** The reference entry text (trimmed; truncated for prose). */
  raw: string;
  title?: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
}

export interface RawReferences {
  /** All extracted links — internal (markdown/wikilink/relative href) AND external
   * (absolute http(s) URLs + bare URLs). Consumers filter via `isExternalTarget`:
   * the Phase-0 resolver keeps internal ones; the Phase-1 web fetcher takes external. */
  links?: RawLink[];
  citations?: RawCitation[];
}

// --- ID patterns (global; reused for block + inline scans) --------------------
const ARXIV_RE = /arxiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/gi;
const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+/gi;
const PMID_RE = /\bpmid:\s*(\d{1,9})\b/gi;
const REF_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:[\divxlc]+\.?\s+)?(references|bibliography|works cited)\s*:?\s*$/i;

/** Strip trailing punctuation a DOI/URL regex commonly over-captures. */
function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:)\]]+$/, "");
}

/** http(s)/protocol-relative/mailto/tel/data targets — external, not a corpus file. */
export function isExternalTarget(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

// --- Internal links -----------------------------------------------------------

/** Markdown inline links `[text](target)` (excluding `![images]`) + `[[wikilinks]]`. */
export function extractMarkdownLinks(text: string): RawLink[] {
  const links: RawLink[] = [];

  // `[text](target ...)` but not image `![text](...)`; ignore pure `#fragment`.
  const inline = /(?<!!)\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;
  for (const m of text.matchAll(inline)) {
    const target = m[2].trim();
    if (!target || target.startsWith("#")) continue;
    links.push({ target, text: m[1].trim() || undefined, kind: "markdown" });
  }

  // `[[target]]` or `[[target|alias]]`.
  const wiki = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
  for (const m of text.matchAll(wiki)) {
    const target = m[1].trim();
    if (!target) continue;
    links.push({ target, text: m[2]?.trim() || undefined, kind: "wikilink" });
  }

  return links;
}

/** Anchor `href`s from raw HTML; ignores pure `#fragment` links. */
export function extractHtmlLinks(html: string): RawLink[] {
  const links: RawLink[] = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    const target = m[1].trim();
    if (!target || target.startsWith("#")) continue;
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    links.push({ target, text: text || undefined, kind: "html" });
  }
  return links;
}

/**
 * Bare absolute URLs anywhere in the text — `> source: https://…` web-clip
 * frontmatter, `Source: …` lines, and inline bare links the markdown-link regex
 * misses (web clips often flatten `[t](u)` to plain text + a source header).
 * These are external by construction; the Phase-1 fetcher consumes them (gated
 * by the allowlist), the Phase-0 resolver ignores them.
 */
export function extractBareUrls(text: string): RawLink[] {
  const seen = new Set<string>();
  const out: RawLink[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)<>"'\]}|]+/gi)) {
    const target = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ target, kind: "url" });
  }
  return out;
}

// --- Citations ----------------------------------------------------------------

function citationKey(c: RawCitation): string {
  return (
    c.arxivId?.toLowerCase() ??
    c.doi?.toLowerCase() ??
    (c.pmid ? `pmid:${c.pmid}` : undefined) ??
    c.title?.toLowerCase() ??
    c.raw.toLowerCase()
  );
}

/** Pull arXiv-id / DOI / PMID out of a single reference string. */
function extractIds(s: string): Pick<RawCitation, "arxivId" | "doi" | "pmid"> {
  const arxiv = new RegExp(ARXIV_RE.source, "i").exec(s);
  const doi = new RegExp(DOI_RE.source, "i").exec(s);
  const pmid = new RegExp(PMID_RE.source, "i").exec(s);
  return {
    ...(arxiv ? { arxivId: arxiv[1] } : {}),
    ...(doi ? { doi: trimTrailingPunct(doi[0]) } : {}),
    ...(pmid ? { pmid: pmid[1] } : {}),
  };
}

/** Structured parse via Citation.js; returns [] (not throw) on non-BibTeX input. */
function parseStructured(block: string): RawCitation[] {
  if (!/@\w+\s*\{/.test(block)) return []; // cheap guard: looks like BibTeX?
  const Cite = loadCite();
  if (!Cite) return [];
  try {
    const entries = new Cite(block).data ?? [];
    return entries
      .map((e): RawCitation => {
        const raw = (e.title ?? "").toString().trim();
        return {
          raw: raw || JSON.stringify(e).slice(0, 200),
          ...(e.title ? { title: String(e.title) } : {}),
          ...(e.DOI ? { doi: String(e.DOI) } : {}),
        };
      })
      .filter((c) => c.raw.length > 0);
  } catch {
    return [];
  }
}

/** Split a prose bibliography block into entries, marker-aware with line fallback. */
function splitProseEntries(block: string): string[] {
  const lines = block
    .split("\n")
    .filter((l, i) => !(i === 0 && REF_HEADING_RE.test(l.trim()))) // drop a leading heading
    .map((l) => l.trim());

  const marker = /^\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s+/;
  const hasMarkers = lines.some((l) => marker.test(l));

  if (hasMarkers) {
    const entries: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      if (marker.test(line)) entries.push(line.replace(marker, ""));
      else if (entries.length) entries[entries.length - 1] += ` ${line}`;
      else entries.push(line);
    }
    return entries;
  }
  // No numbering: one entry per non-empty line.
  return lines.filter(Boolean);
}

/**
 * Extract citations from a (possibly undefined) trailing references block plus
 * inline arXiv/DOI ids found anywhere in the body. Deduped by id/title.
 */
export function extractCitations(
  referencesBlock: string | undefined,
  bodyText: string
): RawCitation[] {
  const out = new Map<string, RawCitation>();
  const add = (c: RawCitation) => {
    const key = citationKey(c);
    if (key && !out.has(key)) out.set(key, c);
  };

  if (referencesBlock && referencesBlock.trim()) {
    const structured = parseStructured(referencesBlock);
    if (structured.length) {
      structured.forEach((c) => add({ ...c, ...extractIds(c.raw + " " + (c.doi ?? "")) }));
    } else {
      for (const entry of splitProseEntries(referencesBlock)) {
        const ids = extractIds(entry);
        add({ raw: entry.slice(0, 300), ...ids });
      }
    }
  }

  // Inline ids in the body (e.g. "see arXiv:2001.12345") that aren't in the list.
  for (const m of bodyText.matchAll(new RegExp(ARXIV_RE.source, "gi"))) {
    add({ raw: m[0], arxivId: m[1] });
  }
  for (const m of bodyText.matchAll(new RegExp(DOI_RE.source, "gi"))) {
    add({ raw: m[0], doi: trimTrailingPunct(m[0]) });
  }
  for (const m of bodyText.matchAll(new RegExp(PMID_RE.source, "gi"))) {
    add({ raw: m[0], pmid: m[1] });
  }

  return Array.from(out.values());
}
