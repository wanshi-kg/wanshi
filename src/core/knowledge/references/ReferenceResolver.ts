import * as path from "path";
import { Entity, KnowledgeGraph, Observation, ProcessedFile, Relation } from "../../../types";
import {
  RawCitation,
  RawLink,
  RawReferences,
  isExternalTarget,
} from "../../processor/readers/referenceExtraction";
import { toRelPathId } from "../../corpus/relPath";

/**
 * Corpus-level reference resolver (Phase 0, network-free). Turns a file's raw
 * `metadata.references` (links + citations extracted by the readers) into a
 * deterministic `KnowledgeGraph` of `document` nodes and `links_to` / `cites`
 * edges, mirroring the AST-seed pattern: emitted per file and merged with the
 * LLM's per-chunk graphs (the merger dedups document nodes by name across files,
 * so an edge's endpoints unify even when the target file emits its own node).
 *
 * Document nodes are keyed by corpus-relative posix path (`toRelPathId`) — stable
 * and identical across a link's source and target. This intentionally does NOT
 * reuse `KnowledgeGraphBuilder.documentIdentityGraph`'s *title*-named node (a
 * path key is required for correct internal-link resolution); consolidating the
 * two `document` nodes is a deliberate follow-up, not this phase.
 *
 * Network classes — external web links and citation span-fetch — are later
 * phases; here every `cites` edge (and any unresolved internal link) is a bare
 * edge with `resolved: false`. The target node carries only what the reference
 * itself states (ids/title), never fabricated content.
 */

const DOC = "document";

export interface ReferenceResolveOptions {
  internalLinks: boolean;
  citations: boolean;
}

export function buildReferenceGraph(
  processedFile: ProcessedFile,
  corpusRelPaths: Set<string>,
  inputRoot: string,
  opts: ReferenceResolveOptions
): KnowledgeGraph | null {
  const refs = processedFile.metadata?.references as RawReferences | undefined;
  if (!refs) return null;

  const fileRel = toRelPathId(inputRoot, processedFile.path);
  const createdAt = new Date().toISOString();
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];
  const seenEdge = new Set<string>();

  const ensureDoc = (name: string, filePath?: string, observations: Observation[] = []) => {
    const existing = entities.get(name);
    if (existing) {
      if (observations.length) existing.observations.push(...observations);
      if (filePath && !existing.files.includes(filePath)) existing.files.push(filePath);
      return;
    }
    entities.set(name, { name, entityType: DOC, files: filePath ? [filePath] : [], observations });
  };

  const addEdge = (to: string, type: string, resolved: boolean) => {
    if (!to || to === fileRel) return; // skip empties + self-loops
    const key = `${to}:${type}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    relations.push({ from: fileRel, to, relationType: [type], source: fileRel, resolved });
  };

  // Source file node — guarantees the `from` endpoint always exists.
  ensureDoc(fileRel, processedFile.path);

  if (opts.internalLinks && refs.internalLinks?.length) {
    for (const link of refs.internalLinks) {
      if (isExternalTarget(link.target)) continue; // external web is Phase 1
      const resolved = resolveInternalTarget(link, fileRel, corpusRelPaths);
      const target = resolved ?? link.target;
      ensureDoc(target, resolved ? path.resolve(inputRoot, resolved) : undefined);
      addEdge(target, "links_to", !!resolved);
    }
  }

  if (opts.citations && refs.citations?.length) {
    for (const c of refs.citations) {
      const name = citationNodeName(c);
      ensureDoc(name, undefined, citationObservations(c, fileRel, createdAt));
      addEdge(name, "cites", false); // resolution/fetch is a later phase
    }
  }

  if (!relations.length) return null;
  return { entities: Array.from(entities.values()), relations };
}

/**
 * Resolve an internal link target to a corpus-relative path, or null if absent.
 * Exported so reference-driven ingestion (the follow worklist) resolves link
 * targets with the exact same normalization used to emit `links_to` edges.
 */
export function resolveInternalTarget(
  link: RawLink,
  fileRel: string,
  corpus: Set<string>
): string | null {
  if (link.kind === "wikilink") return resolveWikilink(link.target, corpus);

  const stripped = link.target.split("#")[0].split("?")[0].trim();
  if (!stripped) return null;

  const base = stripped.startsWith("/")
    ? stripped.slice(1)
    : path.posix.join(path.posix.dirname(fileRel), stripped);
  const norm = path.posix.normalize(base);

  const candidates = [norm];
  if (!path.posix.extname(norm)) {
    candidates.push(`${norm}.md`, path.posix.join(norm, "index.md"));
  }
  return candidates.find((c) => corpus.has(c)) ?? null;
}

/** Match a `[[wikilink]]` note name against corpus file basenames. */
function resolveWikilink(target: string, corpus: Set<string>): string | null {
  const slug = target.trim().toLowerCase();
  const wants = new Set([
    slug,
    slug.replace(/\s+/g, "-"),
    slug.replace(/\s+/g, "_"),
    slug.replace(/\s+/g, ""),
  ]);
  for (const rel of corpus) {
    const baseNoExt = rel.toLowerCase().split("/").pop()!.replace(/\.[^.]+$/, "");
    if (wants.has(baseNoExt)) return rel;
  }
  return null;
}

/** Stable node name for a cited work: prefer a hard id, then title, then text. */
function citationNodeName(c: RawCitation): string {
  if (c.arxivId) return `arXiv:${c.arxivId}`;
  if (c.doi) return `doi:${c.doi}`;
  if (c.pmid) return `PMID:${c.pmid}`;
  if (c.title) return c.title;
  return c.raw.slice(0, 120);
}

/** The reference's own stated metadata as observations (not fabricated content). */
function citationObservations(c: RawCitation, source: string, createdAt: string): Observation[] {
  const obs: Observation[] = [];
  const push = (text: string) => obs.push({ text, source, createdAt });
  if (c.title) push(`Title: ${c.title}`);
  if (c.arxivId) push(`arXiv:${c.arxivId}`);
  if (c.doi) push(`DOI: ${c.doi}`);
  if (c.pmid) push(`PMID: ${c.pmid}`);
  return obs;
}
