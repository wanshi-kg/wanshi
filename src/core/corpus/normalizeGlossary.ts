import { CorpusGlossary } from "../../types";

/**
 * Validate + normalize a raw corpus glossary before it becomes the authoritative
 * closed vocabulary (KG-06).
 *
 * The glossary LLM (often the weakest model in the pipeline) emits sprawl: 29
 * types when the prompt asked for 8–20, spaced predicates (`is a`, `part of`)
 * that duplicate base predicates, the style-guide-banned `has_*` attribute
 * family, and case-fragmented pairs (`Concept` + `concept`). Left raw, that gets
 * *enforced* as the Zod enum. This normalizes types/predicates to lowercase
 * `snake_case` (so case/space variants collapse with the base set downstream),
 * drops the `has_*` family from relations, dedupes, and caps each list to the
 * prompt's own limits. Names are only trimmed + case-deduped (never enum'd, so
 * proper-noun casing is preserved).
 */

export interface GlossaryCaps {
  /** Max entity types kept (prompt asks 8–20). */
  entityCap?: number;
  /** Max relation predicates kept (prompt asks 6–15). */
  relationCap?: number;
}

const DEFAULT_ENTITY_CAP = 20;
const DEFAULT_RELATION_CAP = 15;

/** Lowercase + `snake_case` a type/predicate token; '' when nothing survives. */
function toSnakeType(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // spaces, hyphens, slashes, unicode dashes → _
    .replace(/^_+|_+$/g, ""); // trim leading/trailing underscores
}

/** Normalize a type/predicate list: snake_case, dedupe, reject has_*, cap. */
function normalizeTypeList(
  raw: string[] | undefined,
  cap: number,
  rejectHasPrefix: boolean
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw ?? []) {
    const s = toSnakeType(item);
    if (!s) continue;
    // The banned attribute family (`has_format`, `has_length`, …). The legit
    // base predicate `has_attribute` is supplied by the base set downstream, so
    // dropping it from the glossary loses nothing.
    if (rejectHasPrefix && s.startsWith("has_")) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Trim + case-insensitive dedupe entity names, preserving first-seen casing. */
function normalizeNames(raw: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw ?? []) {
    const t = name.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function normalizeGlossary(
  raw: CorpusGlossary,
  caps: GlossaryCaps = {}
): CorpusGlossary {
  return {
    entityNames: normalizeNames(raw.entityNames),
    entityTypes: normalizeTypeList(
      raw.entityTypes,
      caps.entityCap ?? DEFAULT_ENTITY_CAP,
      false
    ),
    relationTypes: normalizeTypeList(
      raw.relationTypes,
      caps.relationCap ?? DEFAULT_RELATION_CAP,
      true
    ),
  };
}
