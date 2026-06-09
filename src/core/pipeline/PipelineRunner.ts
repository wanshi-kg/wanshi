import { KnowledgeGraph } from "../../types/KnowledgeGraph";
import { ProcessingOptions } from "../../config";
import { IEmbeddingProvider } from "../../types/IEmbeddingProvider";
import { ILLMProvider } from "../../types/ILLMProvider";
import { Logger } from "../../shared";

/**
 * Shared state a graph→graph transform needs. Providers are resolved once and
 * passed in (rather than each transform reaching into the container), so a
 * transform is a plain, testable object.
 */
export interface TransformContext {
  options: ProcessingOptions;
  embeddings: IEmbeddingProvider;
  llm: ILLMProvider;
  logger: Logger;
}

/**
 * A post-extraction stage that rewrites the merged graph (grounding gate,
 * canonicalization, …). The pragmatic stage engine (canon brief §3): producer
 * stages run in DirectoryProcessor as before; these reorderable transforms are
 * driven by `pipeline.stages`.
 */
export interface GraphTransform {
  /** Stage token this transform handles, e.g. "grounding" / "canonicalization". */
  readonly stage: string;
  /** Whether this transform should run, given the config. */
  isEnabled(ctx: TransformContext): boolean;
  apply(graph: KnowledgeGraph, ctx: TransformContext): Promise<KnowledgeGraph>;
}

/** Stage tokens that resolve to post-extraction graph→graph transforms. */
export const TRANSFORM_STAGES = ["grounding", "canonicalization"] as const;

/**
 * Runs the enabled graph→graph transforms in the order given by
 * `pipeline.stages`. Producer tokens (tf_analysis / schema_induction /
 * extraction) and unknown tokens are skipped here — they're handled (or ignored)
 * upstream. Reordering `pipeline.stages` reorders the transforms (the seam
 * Experiment 2 needs: grounding before canonicalization).
 */
export class PipelineRunner {
  constructor(
    private transforms: GraphTransform[],
    private ctx: TransformContext
  ) {}

  /** True when at least one registered transform is enabled by the config. */
  hasWork(): boolean {
    return this.transforms.some((t) => t.isEnabled(this.ctx));
  }

  async run(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    const byStage = new Map(this.transforms.map((t) => [t.stage, t]));
    let current = graph;
    for (const token of this.ctx.options.pipeline.stages) {
      const transform = byStage.get(token);
      if (!transform) continue; // producer/unknown stage — not our concern here
      if (!transform.isEnabled(this.ctx)) {
        this.ctx.logger.debug(`Pipeline stage '${token}' disabled — skipping`);
        continue;
      }
      this.ctx.logger.info(`Pipeline stage '${token}' running`);
      current = await transform.apply(current, this.ctx);
    }
    return current;
  }
}
