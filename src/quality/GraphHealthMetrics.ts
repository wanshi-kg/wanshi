import { KnowledgeGraph } from '../types';

/**
 * Graph "health" / topology-hygiene metrics — the no-ground-truth half of the
 * canonicalization A/B scorecard (brief §2 / §9). These are the numbers a
 * canonicalization pass should improve (fewer entity/relation types) without
 * making worse (self-loops, contradictions, dangling endpoints).
 *
 * Pure and synchronous — no embeddings, no LLM, no I/O — so the same function
 * scores the baseline arm and every canon arm uniformly and offline. The
 * ground-truth-dependent metrics (fabricated-edge rate, ER precision/recall)
 * live in the `kg-gen metrics --ground-truth` path, which needs embeddings.
 */
export interface GraphHealthMetrics {
  entityCount: number;
  relationCount: number;
  /** Distinct entityType values — the entity-type "sprawl" number. */
  entityTypeCount: number;
  /** Distinct relation predicate strings — the relation-type "sprawl" number. */
  relationTypeCount: number;
  /** Edges with from === to (extraction artifact). */
  selfLoopCount: number;
  /** Unordered entity pairs {A,B} that have edges in BOTH directions (A→B and B→A). */
  bidirectionalContradictionCount: number;
  /** Edges whose `from` or `to` is not a defined entity. */
  danglingEndpointCount: number;
  /** 1 − dangling/relationCount (1 when there are no relations). */
  referentialIntegrity: number;
  /** Extra edges sharing the same (from, to, normalized-predicate-set) key. */
  parallelEdgeCount: number;
}

const SEP = '␟'; // unit-separator, safe against names containing punctuation

/** Order-/case-insensitive predicate-set key so reversed/recased twins collapse. */
function normPredicate(relationType: string[] | string): string {
  const arr = Array.isArray(relationType) ? relationType : [relationType];
  return Array.from(
    new Set(arr.map((t) => t.trim().toLowerCase()).filter(Boolean))
  )
    .sort()
    .join(',');
}

export function computeGraphHealth(graph: KnowledgeGraph): GraphHealthMetrics {
  const entities = graph.entities ?? [];
  const relations = graph.relations ?? [];

  const entityNames = new Set(entities.map((e) => e.name));
  const entityTypes = new Set(entities.map((e) => e.entityType).filter(Boolean));

  const relationTypes = new Set<string>();
  for (const r of relations) {
    const arr = Array.isArray(r.relationType) ? r.relationType : [r.relationType];
    for (const t of arr) if (t) relationTypes.add(t);
  }

  let selfLoopCount = 0;
  let danglingEndpointCount = 0;
  const directed = new Set<string>();
  const edgeKeys = new Set<string>();
  let parallelEdgeCount = 0;

  for (const r of relations) {
    if (r.from === r.to) selfLoopCount++;
    if (!entityNames.has(r.from) || !entityNames.has(r.to)) danglingEndpointCount++;

    if (r.from !== r.to) directed.add(r.from + SEP + r.to);

    const key = r.from + SEP + r.to + SEP + normPredicate(r.relationType);
    if (edgeKeys.has(key)) parallelEdgeCount++;
    else edgeKeys.add(key);
  }

  // Count unordered pairs present in both directions, once each.
  let bidirectionalContradictionCount = 0;
  const countedPair = new Set<string>();
  for (const key of directed) {
    const [a, b] = key.split(SEP);
    if (directed.has(b + SEP + a)) {
      const pair = a < b ? a + SEP + b : b + SEP + a;
      if (!countedPair.has(pair)) {
        countedPair.add(pair);
        bidirectionalContradictionCount++;
      }
    }
  }

  return {
    entityCount: entities.length,
    relationCount: relations.length,
    entityTypeCount: entityTypes.size,
    relationTypeCount: relationTypes.size,
    selfLoopCount,
    bidirectionalContradictionCount,
    danglingEndpointCount,
    referentialIntegrity:
      relations.length > 0 ? 1 - danglingEndpointCount / relations.length : 1,
    parallelEdgeCount,
  };
}
