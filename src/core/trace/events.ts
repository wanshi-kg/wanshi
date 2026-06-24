/**
 * Debug trace event taxonomy. One `type` per pipeline decision point. Every event
 * is wrapped by `TraceWriter` in an envelope (`v`/`runId`/`ts`/`seq`) before it
 * hits the JSONL sidecar — these interfaces describe the per-event *payload*.
 *
 * Bump TRACE_VERSION whenever an event's shape changes (same discipline as the
 * checkpoint key / prompt version) so a future inspector can branch on it.
 */
export const TRACE_VERSION = 1;

export type TraceStage =
  | "run"
  | "ingest"
  | "classify"
  | "extract"
  | "ground"
  | "merge"
  | "export";

/** Envelope stamped by the writer onto every emitted event. */
export interface TraceEnvelope {
  v: number;
  runId: string;
  ts: string; // ISO-8601
  seq: number; // monotonic per run — preserves order independent of fs flush timing
}

export interface RunStartEvent {
  stage: "run";
  type: "run_start";
  output: string;
  /** A resumed run skips checkpointed chunks, so its trace is partial — flagged here. */
  resumed: boolean;
  config?: Record<string, unknown>;
}

export interface ChunkEvent {
  stage: "ingest";
  type: "chunk";
  chunkId: string; // `<relPath>#<index>`
  file: string;
  chunkIndex: number;
  totalChunks: number;
  reader: string;
  contentLength: number;
  provenance?: Record<string, unknown>;
}

export interface ClassificationEvent {
  stage: "classify";
  type: "classification";
  file: string;
  distribution: Array<{ class: string; confidence: number }>;
  gate: "abstain" | "single" | "multi";
  activeClasses: string[];
  escalated: boolean;
  tieBreak?: { tied: [string, string]; pick: string | null };
}

export interface EntityMentionRef {
  mentionId: string;
  name: string;
  entityType: string;
  observationIds: string[];
}

export interface RelationMentionRef {
  mentionId: string;
  from: string;
  to: string;
  relationType: string[];
}

export interface ExtractionEvent {
  stage: "extract";
  type: "extraction";
  extractionId: string; // `<chunkId>@0` (the builder retries in-place; no per-attempt event)
  chunkId: string;
  file: string;
  chunkIndex: number;
  model: string;
  promptVersion: string;
  checkpointHit: boolean;
  entityMentions: EntityMentionRef[];
  relationMentions: RelationMentionRef[];
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  failed?: boolean;
  error?: string;
}

export interface GroundingEvent {
  stage: "ground";
  type: "grounding";
  extractionId: string;
  chunkId: string;
  mentionId?: string;
  kind: "observation" | "relation";
  subject: string; // entity name, or `from→to`
  claim: string;
  score: number;
  checker: string; // "keyword" | "minicheck"
  decision: "accept" | "flag" | "drop";
}

export interface MergeDecisionEvent {
  stage: "merge";
  type: "merge_decision";
  mergeDecisionId: string;
  target: "entity" | "relation";
  canonical: string;
  surfaceForms: string[];
  /** Pre-merge mention IDs that fold into the canonical node (lineage thread). */
  foldedMentionIds?: string[];
  cosine?: number;
  method: string; // "string-exact" | "string-jw" | "embeddings" | "llm" | "hybrid"
  /** Final accept (merged) vs reject (kept distinct). */
  verdict: "accept" | "reject";
  /** Whether an LLM adjudicator was consulted, and what it returned (was discarded before). */
  adjudicated?: boolean;
  adjudicatorVerdict?: boolean;
}

export interface ExportEvent {
  stage: "export";
  type: "export";
  format: string;
  entities: number;
  relations: number;
}

export type TraceEvent =
  | RunStartEvent
  | ChunkEvent
  | ClassificationEvent
  | ExtractionEvent
  | GroundingEvent
  | MergeDecisionEvent
  | ExportEvent;

export type TraceRecord = TraceEvent & TraceEnvelope;
