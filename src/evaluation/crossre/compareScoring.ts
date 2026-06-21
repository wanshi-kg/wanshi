import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { Triplet } from '../datasets/IDataset';

/**
 * Flatten a KnowledgeGraph's relations into triplets — one per relationType label.
 * An empty/blank relationType falls back to `related to`, mirroring
 * `MineDataset.toGraph` (which gives KGGen's empty edges the same label). Without
 * this, wanshi relations that came back with `relationType: []` would silently
 * vanish from the triplet metrics while KGGen's empty edges survive — an asymmetry
 * that would understate wanshi on the relation/triple levels.
 */
export function kgToTriplets(kg: KnowledgeGraph): Triplet[] {
  return kg.relations.flatMap((r) => {
    const labels = r.relationType.length ? r.relationType : ['related to'];
    return labels.map((rel) => ({ subject: r.from, predicate: rel || 'related to', object: r.to }));
  });
}

/**
 * Represent each graph NODE as a self-triplet so the existing
 * Exact/SemanticMatcher.matchEntities (which reads subjects ∪ objects) measures
 * entity-capture over the full node set — NOT just relation endpoints. This is the
 * fair cross-tool headline: "did the tool recover the gold entities at all",
 * independent of whether it also drew an edge between them (wanshi is edge-sparse,
 * so scoring entities only via relation endpoints would understate it).
 */
export function nodeTriplets(kg: KnowledgeGraph): Triplet[] {
  return kg.entities.map((e) => ({ subject: e.name, predicate: '', object: e.name }));
}
