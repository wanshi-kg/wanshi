/**
 * Frontend mirror of wanshi's knowledge-graph data model
 * (src/types/KnowledgeGraph.ts + src/types/Observation.ts). The graph-loader
 * normalizes every export format (json/jsonl/mcp-jsonl) into this shape.
 */
import type { TrustSignal } from "./trust"

export interface Observation {
  text: string
  speaker?: string
  source?: string
  validAt?: string
  invalidAt?: string
  createdAt?: string
  expiredAt?: string
  // Inline grounding gate (`--grounding flag`): grounded=false marks an ungrounded fact.
  grounded?: boolean
  groundingScore?: number // 0..1 keyword-overlap with the source chunk
  // ECS source-tagging — which adapter produced the fact + where in the source
  // (e.g. "pdf:mistral"/"sqlite", "p.67"/"table:parts/row:42").
  sourceAdapter?: string
  locator?: string
  // Read-reliability 0..1 (NOT a truth verdict) — set by EXIF/C2PA + the CV pre-pass.
  confidence?: number
}

export interface Entity {
  name: string
  entityType: string
  observations: Observation[]
  files: string[]
  chunk?: number
  totalChunks?: number
}

export interface Relation {
  from: string
  to: string
  relationType: string[]
  /** The source span (chunk text) this edge was extracted from (grounding stage). */
  sourceSpan?: string
  /** Bi-temporal valid time, mirrored from chunk provenance when known. */
  validAt?: string
  // Inline grounding gate: grounded=false marks an ungrounded edge.
  grounded?: boolean
  groundingScore?: number // 0..1 grounding score for the verbalized triple
  /** Reference-resolution edges (links_to/cites/references): the emitting document. */
  source?: string
  /** Reference-resolution edges: false = a bare edge to a stub/external target. */
  resolved?: boolean
  /** Citation span-fetch faithfulness (Phase 2c) for a resolved `cites` edge. */
  faithfulness?: "supported" | "unsupported" | "uncertain"
  faithfulnessScore?: number // 0..1 support score from the faithfulness checker
  supportingSpan?: string // the cited-work passage the claim was checked against
}

export interface KnowledgeGraph {
  entities: Entity[]
  relations: Relation[]
}

// --- derived shapes for the UI ----------------------------------------------

/** A {label, count} bucket for the type-distribution charts. */
export interface TypeCount {
  type: string
  count: number
}

/** A node for the force-directed graph (one per entity, + placeholders). */
export interface ForceNode {
  id: string
  name: string
  entityType: string
  /** Degree (number of incident relations) — drives node size. */
  degree: number
  /** True when only referenced by a relation, never extracted as an entity. */
  unresolved?: boolean
  /** Aggregated trust over the entity's observations — drives opacity + ring. */
  trust?: TrustSignal
}

export interface ForceLink {
  source: string
  target: string
  relationType: string[]
  /** Edge trust (grounding/faithfulness) — surfaces unfaithful edges on the canvas. */
  trust?: TrustSignal
}

export interface ForceData {
  nodes: ForceNode[]
  links: ForceLink[]
}
