/**
 * One per-cluster record in a merge log (canon brief §7 — the deliverable).
 * Shared by the Canonicalizer (embedding clusters) and KnowledgeMerger
 * (string-merge fusions) so `kg-gen inspect-merges` reads both unchanged.
 */
export interface MergeRecord {
  cluster_id: string;
  target: "entity" | "relation";
  surface_forms: string[];
  canonical_chosen: string;
  member_count: number;
  method: string;
  intra_cluster_sim: { min: number; max: number };
  borderline_pairs: Array<{ a: string; b: string; sim: number; merged: boolean }>;
  source_spans: string[];
}
