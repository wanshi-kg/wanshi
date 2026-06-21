/**
 * Trust derivation — the semantic heart of the inspector's identity.
 *
 * Turns the raw provenance fields wanshi stamps on a fact (grounding gate,
 * bi-temporal axis, faithfulness verdict, source adapter, confidence) into a
 * single, immediately-readable {@link TrustState} plus an optional 0..1
 * confidence scalar for the gradient. This is PURE logic — no colors, no React.
 * The visual language (color/icon/opacity) lives in the design seam
 * (`lib/graph-colors.ts` + `globals.css`) and reads this module's output.
 *
 * Tri-state discipline: absent signals → `unknown`, NEVER `ungrounded`. A
 * default run (grounding gate off) or an `mcp-jsonl` graph (provenance stripped)
 * reads "no signal", not "untrusted" — we don't fabricate a verdict we don't have.
 */
import type { Observation, Relation, TrustSignal, TrustState } from "@/types"

// The vocabulary lives in `types/trust.ts` (so data projections can use it
// without a cycle); re-export for existing `@/lib/trust` consumers.
export type { TrustSignal, TrustState }

/**
 * `sourceAdapter` ids that denote a low-trust *machine* read, per the brief
 * (OCR + CV signals). EXIF/C2PA are deterministic *high*-trust reads, so they
 * are deliberately excluded — they carry their own high `confidence` instead.
 * Tunable at convergence with Sable's trust language.
 */
const TOOL_DERIVED_PREFIXES = ["cv-", "pdf:tesseract", "pdf:mistral", "pdf:docling", "pdf:marker", "pdf:chandra"]

function isToolDerived(sourceAdapter?: string): boolean {
  if (!sourceAdapter) return false
  return TOOL_DERIVED_PREFIXES.some((p) => sourceAdapter.startsWith(p))
}

/** Trust for a single observation (fact). */
export function deriveObservationTrust(o: Observation): TrustSignal {
  // Gradient scalar: explicit read-reliability first, else the grounding score.
  const confidence = o.confidence ?? o.groundingScore

  // Priority: temporal supersession → grounding verdict → tool origin → confirmed → none.
  if (o.invalidAt || o.expiredAt) return { state: "superseded", confidence }
  if (o.grounded === false) return { state: "ungrounded", confidence }
  if (isToolDerived(o.sourceAdapter)) return { state: "tool-derived", confidence }
  if (o.grounded === true) return { state: "grounded", confidence }
  return { state: "unknown", confidence }
}

/** Trust for a single relation (edge). */
export function deriveRelationTrust(r: Relation): TrustSignal {
  const confidence = r.faithfulnessScore ?? r.groundingScore

  // Faithfulness verdict (citation span-fetch) is the most specific signal.
  if (r.faithfulness === "unsupported") return { state: "ungrounded", confidence }
  if (r.faithfulness === "uncertain") return { state: "uncertain", confidence }
  if (r.faithfulness === "supported") return { state: "grounded", confidence }

  // Inline grounding gate on edges.
  if (r.grounded === false) return { state: "ungrounded", confidence }
  if (r.grounded === true) return { state: "grounded", confidence }

  // A reference edge whose target was never resolved/fetched — a known gap.
  if (r.resolved === false) return { state: "uncertain", confidence }

  return { state: "unknown", confidence }
}

/**
 * Severity rank — how much an analyst's attention a state warrants. Used to pick
 * a single node-level state from many observations (the loudest signal wins).
 */
const SEVERITY: Record<TrustState, number> = {
  ungrounded: 6,
  uncertain: 5,
  superseded: 4,
  contradicted: 4,
  "tool-derived": 3,
  grounded: 2,
  unknown: 1,
}

/**
 * Aggregate a node's observations into one trust signal: the highest-severity
 * observation state, and the mean of whatever confidence scalars are present
 * (absent ⇒ undefined, so the canvas leaves the node at full opacity rather
 * than fading an un-scored node toward invisible).
 */
export function deriveNodeTrust(observations: Observation[]): TrustSignal {
  if (observations.length === 0) return { state: "unknown" }
  let state: TrustState = "unknown"
  const confs: number[] = []
  for (const o of observations) {
    const t = deriveObservationTrust(o)
    if (SEVERITY[t.state] > SEVERITY[state]) state = t.state
    if (typeof t.confidence === "number") confs.push(t.confidence)
  }
  const confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined
  return { state, confidence }
}

/** Human-readable label for a trust state (UI chrome). */
export function trustLabel(state: TrustState): string {
  switch (state) {
    case "tool-derived":
      return "tool-derived"
    default:
      return state
  }
}
