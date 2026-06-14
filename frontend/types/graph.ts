/**
 * Frontend mirror of wanshi's knowledge-graph data model
 * (src/types/KnowledgeGraph.ts + src/types/Observation.ts). The graph-loader
 * normalizes every export format (json/jsonl/mcp-jsonl) into this shape.
 */
export interface Observation {
  text: string
  speaker?: string
  source?: string
  validAt?: string
  invalidAt?: string
  createdAt?: string
  expiredAt?: string
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
}

export interface ForceLink {
  source: string
  target: string
  relationType: string[]
}

export interface ForceData {
  nodes: ForceNode[]
  links: ForceLink[]
}
