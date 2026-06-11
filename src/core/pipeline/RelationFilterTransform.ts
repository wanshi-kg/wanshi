import { KnowledgeGraph, Relation } from "../../types/KnowledgeGraph";
import { GraphTransform, TransformContext } from "./PipelineRunner";

/** True when an edge's predicate set is purely the `related_to` catch-all. */
function isRelatedToOnly(r: Relation): boolean {
  const types = Array.isArray(r.relationType) ? r.relationType : [r.relationType];
  return types.length > 0 && types.every((t) => t === "related_to");
}

const pairKey = (a: string, b: string): string => `${a}␟${b}`;

/**
 * `related_to` pruning gate (canon brief / NR-4). `related_to` is the relation
 * layer's catch-all — on prose corpora it's a large, low-value fraction. This runs
 * AFTER canonicalization (so endpoint names are already canonical) and prunes per
 * `pipeline.relationFilter.mode`:
 *   - off       (default) — no change
 *   - redundant — drop a `related_to` edge only when the same unordered endpoint pair
 *                 already carries a typed (non-`related_to`) edge: pure redundancy, no
 *                 information lost.
 *   - all       — drop every `related_to` edge (for consumers wanting typed-only graphs).
 *
 * Re-typing ungrounded `related_to` edges to real predicates needs an LLM pass and is
 * intentionally out of scope here (a future mode).
 */
export class RelationFilterTransform implements GraphTransform {
  readonly stage = "relationFilter";

  isEnabled(ctx: TransformContext): boolean {
    return ctx.options.pipeline.relationFilter.mode !== "off";
  }

  async apply(graph: KnowledgeGraph, ctx: TransformContext): Promise<KnowledgeGraph> {
    const mode = ctx.options.pipeline.relationFilter.mode;
    if (mode === "off") return graph;

    // Unordered endpoint pairs that carry at least one typed edge.
    const typedPairs = new Set<string>();
    if (mode === "redundant") {
      for (const r of graph.relations) {
        if (isRelatedToOnly(r)) continue;
        typedPairs.add(pairKey(r.from, r.to));
        typedPairs.add(pairKey(r.to, r.from));
      }
    }

    const before = graph.relations.length;
    const relations = graph.relations.filter((r) => {
      if (!isRelatedToOnly(r)) return true;
      if (mode === "all") return false;
      return !typedPairs.has(pairKey(r.from, r.to)); // redundant: keep only if no typed twin
    });

    const dropped = before - relations.length;
    if (dropped > 0) {
      ctx.logger.info(
        `Relation filter (${mode}) dropped ${dropped}/${before} 'related_to' edge(s)`
      );
    }
    return { entities: graph.entities, relations };
  }
}
