import { cosineSimilarity } from "./cosineSimilarity";

/** A surface form paired with its embedding vector. */
export interface Embedded {
  id: string;
  embedding: number[];
}

/** Minimal union-find (path compression + union by size). */
class UnionFind {
  private parent: number[];
  private size: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
  }
  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}

/** Group item indices by their union-find root, returned as id clusters. */
function clustersFromUF(items: Embedded[], uf: UnionFind): string[][] {
  const groups = new Map<number, string[]>();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    const g = groups.get(root);
    if (g) g.push(items[i].id);
    else groups.set(root, [items[i].id]);
  }
  return Array.from(groups.values());
}

/**
 * Single-linkage agglomerative clustering: connected components of the graph
 * where an edge joins two items whose cosine similarity ≥ `threshold`. Pure and
 * synchronous; singletons are returned as one-element clusters. This is the
 * embeddings-method workhorse for canonicalization.
 */
export function agglomerativeClusters(items: Embedded[], threshold: number): string[][] {
  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (cosineSimilarity(items[i].embedding, items[j].embedding) >= threshold) {
        uf.union(i, j);
      }
    }
  }
  return clustersFromUF(items, uf);
}

export type MergeDecision = "merge" | "reject" | "escalate";

export interface BorderlinePair {
  a: string;
  b: string;
  sim: number;
  /** Whether the pair ended up in the same cluster. */
  merged: boolean;
}

export interface ClusterByEmbeddingResult {
  clusters: string[][];
  borderline: BorderlinePair[];
}

export interface ClusterByEmbeddingOptions {
  /** Per-pair decision from cosine similarity and the two surface forms (the method's policy). */
  decide: (sim: number, a: string, b: string) => MergeDecision;
  /** Similarity band [low, high) recorded as borderline for the merge log. */
  band?: [number, number];
  /** Adjudicate an escalated pair (llm/hybrid). Required for "escalate" decisions. */
  adjudicate?: (a: string, b: string, sim: number) => Promise<boolean>;
}

/**
 * Clustering with a pluggable per-pair policy, shared by all canonicalization
 * methods:
 *   - embeddings: decide = sim ≥ threshold ? "merge" : "reject" (no escalation)
 *   - llm/hybrid: decide = sim ≥ high ? "merge" : sim ≥ low ? "escalate" : "reject",
 *     with the band escalated to the LLM adjudicator.
 *
 * "merge" pairs are unioned first; "escalate" pairs are then adjudicated highest
 * similarity first (and skipped when already transitively merged). Pairs whose
 * similarity falls in `band` are recorded as borderline with their final
 * merged/not-merged outcome — the signal the merge-log viewer surfaces.
 */
export async function clusterByEmbedding(
  items: Embedded[],
  opts: ClusterByEmbeddingOptions
): Promise<ClusterByEmbeddingResult> {
  const uf = new UnionFind(items.length);
  const escalate: Array<{ i: number; j: number; sim: number }> = [];
  const bandPairs: Array<{ i: number; j: number; sim: number }> = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = cosineSimilarity(items[i].embedding, items[j].embedding);
      if (opts.band && sim >= opts.band[0] && sim < opts.band[1]) {
        bandPairs.push({ i, j, sim });
      }
      const d = opts.decide(sim, items[i].id, items[j].id);
      if (d === "merge") uf.union(i, j);
      else if (d === "escalate") escalate.push({ i, j, sim });
    }
  }

  // Adjudicate escalated pairs, most-similar first; skip pairs already merged
  // transitively (a no-op the LLM shouldn't be billed for).
  escalate.sort((a, b) => b.sim - a.sim);
  for (const { i, j, sim } of escalate) {
    if (uf.connected(i, j)) continue;
    if (opts.adjudicate && (await opts.adjudicate(items[i].id, items[j].id, sim))) {
      uf.union(i, j);
    }
  }

  // Borderline = band pairs ∪ escalated pairs, with their final outcome.
  const seen = new Set<string>();
  const borderline: BorderlinePair[] = [];
  for (const { i, j, sim } of [...bandPairs, ...escalate]) {
    const key = i + "-" + j;
    if (seen.has(key)) continue;
    seen.add(key);
    borderline.push({
      a: items[i].id,
      b: items[j].id,
      sim,
      merged: uf.connected(i, j),
    });
  }

  return { clusters: clustersFromUF(items, uf), borderline };
}
