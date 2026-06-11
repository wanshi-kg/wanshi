import { KnowledgeGraph } from "../../types/KnowledgeGraph";
import { GraphTransform, TransformContext } from "./PipelineRunner";

/**
 * Edge co-occurrence grounding gate (canon brief §6). Drops relations whose two
 * endpoints don't both appear in the source span the edge was extracted from —
 * a cheap precision gate for high-recall/low-precision extraction.
 *
 * This is a SEAM: OFF for Experiment 1 (schema-first extraction already has
 * implicit garbage suppression). It exists and is tested now so Experiment 2 is
 * a flag flip — there it must run BEFORE canonicalization, or canon canonicalizes
 * junk. Edges only carry `sourceSpan` when `pipeline.grounding.enabled` was set
 * during extraction (see KnowledgeGraphBuilder.toGraph); without a span we keep
 * the edge (conservative — can't judge what we can't see).
 */
export class GroundingTransform implements GraphTransform {
  readonly stage = "grounding";

  isEnabled(ctx: TransformContext): boolean {
    return ctx.options.pipeline.grounding.enabled;
  }

  async apply(graph: KnowledgeGraph, ctx: TransformContext): Promise<KnowledgeGraph> {
    if (!ctx.options.pipeline.grounding.requireCooccurrence) return graph;

    const before = graph.relations.length;
    const relations = graph.relations.filter((r) => {
      if (!r.sourceSpan) return true; // no span → can't judge → keep
      const span = r.sourceSpan.toLowerCase();
      return (
        span.includes(r.from.toLowerCase()) && span.includes(r.to.toLowerCase())
      );
    });

    const dropped = before - relations.length;
    if (dropped > 0) {
      ctx.logger.info(
        `Grounding gate dropped ${dropped}/${before} edge(s) whose endpoints don't co-occur in their source span`
      );
    }
    return { entities: graph.entities, relations };
  }
}
