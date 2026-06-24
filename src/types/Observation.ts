/**
 * A single factual statement about an entity, with provenance and a bi-temporal
 * axis (Graphiti-verbatim). The LLM emits observations as plain strings; the
 * builder wraps each one into an `Observation` deterministically, stamping the
 * source/speaker/time it already knows from the chunk — grounding is *built*, not
 * asked of the model.
 *
 * Temporal fields follow Graphiti's bi-temporal model:
 *  - validAt / invalidAt — *valid time*: when the fact was/Stopped being true in
 *    the world (e.g. the lesson date, the turn timestamp).
 *  - createdAt / expiredAt — *transaction time*: when the system learned the fact
 *    and when it marked it superseded. Facts are superseded (expiredAt set), never
 *    deleted.
 * All timestamps are ISO-8601 strings.
 */
export interface Observation {
  text: string;
  speaker?: string; // who asserted it (per-observation provenance)
  source?: string; // origin file/path/document
  validAt?: string; // valid-time start (true in the world from)
  invalidAt?: string; // valid-time end (stopped being true)
  createdAt?: string; // transaction-time: when extracted/ingested
  expiredAt?: string; // transaction-time: when superseded by the system
  // Inline grounding gate (Phase 3), set when `--grounding flag` is used.
  grounded?: boolean;
  groundingScore?: number; // 0..1 keyword-overlap with the source chunk
  // ECS source-tagging (data-sink adapter track): which adapter produced this
  // fact + where in the source. e.g. sourceAdapter "pdf:mistral"/"sqlite", locator
  // "p.67"/"table:parts/row:42". Makes trust + origin queryable, not format-specific.
  // Export-only provenance: carried through merge and surfaced in exports, but the
  // dedup tie-break keys on observation text only — these fields do not steer it.
  sourceAdapter?: string;
  locator?: string;
  // Read-reliability of this fact, 0..1 — NOT a truth verdict. Set by deterministic
  // image-metadata extractors (EXIF/C2PA → sourceAdapter "exif"/"c2pa") and the
  // opt-in CV pre-pass (confidence-floored, tool-attributed signals); absent on
  // ordinary LLM-extracted observations. Keeps a low-trust tool signal queryably
  // distinct from a high-confidence deterministic read. Export-only provenance:
  // the merge dedup tie-break compares text length, not confidence, so this does
  // not currently influence which near-duplicate observation is kept.
  confidence?: number;
}

/** An observation as stored may be a legacy bare string or a full object. */
export type ObservationLike = string | Observation;

/** Read the text of an observation regardless of legacy/object form. */
export function obsText(o: ObservationLike): string {
  return typeof o === "string" ? o : o.text;
}

/**
 * Coerce to an `Observation`. For a bare string, stamp the supplied provenance;
 * an existing object is returned unchanged (its own fields are authoritative).
 */
export function toObservation(
  o: ObservationLike,
  provenance?: Partial<Observation>
): Observation {
  return typeof o === "string" ? { text: o, ...provenance } : o;
}

/** Normalize a possibly-legacy observation array to `Observation[]`. */
export function normalizeObservations(
  arr: ObservationLike[] | undefined
): Observation[] {
  return (arr ?? []).map((o) => toObservation(o));
}
