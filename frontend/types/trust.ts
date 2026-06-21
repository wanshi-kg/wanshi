/**
 * The trust vocabulary — the inspector's identity. Lives in `types/` so both the
 * derivation logic (`lib/trust.ts`) and the data projections (`ForceNode`/
 * `ForceLink`) can reference it without a circular import. `lib/trust.ts`
 * re-exports these for existing `@/lib/trust` consumers.
 */
export type TrustState =
  | "grounded" // passed the grounding gate / faithfulness "supported"
  | "ungrounded" // grounded === false / faithfulness "unsupported"
  | "uncertain" // faithfulness "uncertain", or an unresolved reference edge
  | "contradicted" // reserved: needs cross-fact analysis (not derived per-item yet)
  | "superseded" // bi-temporal: invalidAt/expiredAt set — no longer current
  | "tool-derived" // low-trust machine read (OCR, cv-detection, cv-forensics)
  | "unknown" // no trust signal present — distinct from ungrounded

export interface TrustSignal {
  state: TrustState
  /** 0..1 reliability scalar for the confidence gradient (drives opacity). */
  confidence?: number
}
