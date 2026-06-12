/**
 * Contradiction checker: judges whether two facts about the *same entity*
 * contradict each other (KG-10). Used by the merge-time supersession pass —
 * when a newer fact contradicts an older one, the older is *invalidated* (its
 * bi-temporal `invalidAt`/`expiredAt` are set), never deleted (Graphiti's
 * "invalidate, don't delete"). Mirrors `IGroundingChecker`: a cheap heuristic
 * default and an optional LLM-backed implementation are interchangeable here.
 */
export interface ContradictionVerdict {
  contradicts: boolean;
  /** Which checker decided. */
  checker: "heuristic" | "llm";
}

export interface IContradictionChecker {
  /** True when `a` and `b` (two facts about one entity) cannot both hold. */
  check(a: string, b: string): Promise<ContradictionVerdict>;
}
