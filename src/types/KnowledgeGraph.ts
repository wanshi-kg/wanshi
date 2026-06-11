import { Observation } from "./Observation";

export interface Entity {
  name: string;
  files: string[];
  chunk?: number;
  totalChunks?: number;
  entityType: string;
  observations: Observation[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string[];
  /**
   * The source span (chunk text) this edge was extracted from. Populated only
   * when the pipeline grounding stage is enabled (so the baseline graph carries
   * no extra weight); the co-occurrence grounding gate and Experiment 2 depend
   * on it. See `KnowledgeGraphBuilder.toGraph` and `GroundingTransform`.
   */
  sourceSpan?: string;
  /** Bi-temporal valid time, mirrored from the chunk provenance when known. */
  validAt?: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}
