/**
 * Grounding checker: judges whether a single claim is supported by a source
 * text. This is the seam the inline grounding gate
 * (`KnowledgeGraphBuilder.applyGroundingGate`) routes through, so the cheap
 * keyword-overlap heuristic and a stronger NLI fact-checker (MiniCheck) are
 * interchangeable behind one interface.
 */
export interface GroundingVerdict {
  /** 0..1 grounding score (keyword overlap, or fraction of supported sentences). */
  score: number;
  /** Final verdict at the gate's threshold. */
  supported: boolean;
  /** Which checker decided — `keyword` when the pre-filter short-circuited. */
  checker: "keyword" | "minicheck";
}

export interface IGroundingChecker {
  /**
   * Judge `claim` against `source`. Implementations may decompose a multi-
   * sentence claim internally (MiniCheck wants atomic claims) and may keep a
   * keyword pre-filter to avoid an NLI call on obviously-grounded claims.
   *
   * `endpoints` (optional) names a relation's two entity endpoints; a keyword
   * pre-filter must require BOTH present in the source before it short-circuit-
   * accepts (a predicate-only overlap mustn't pass an edge). Omitted for a plain
   * observation claim, where the pre-filter behaves as before.
   */
  check(claim: string, source: string, endpoints?: string[]): Promise<GroundingVerdict>;
}
