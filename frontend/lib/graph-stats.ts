import type {
  Entity,
  ForceData,
  ForceLink,
  ForceNode,
  KnowledgeGraph,
  TypeCount,
} from "@/types"
import { deriveNodeTrust, deriveRelationTrust } from "@/lib/trust"

/** Count entities per entityType, descending. */
export function entityTypeCounts(entities: Entity[]): TypeCount[] {
  const counts = new Map<string, number>()
  for (const e of entities) {
    counts.set(e.entityType, (counts.get(e.entityType) ?? 0) + 1)
  }
  return toSortedCounts(counts)
}

/** Count relations per relationType label (a relation may carry several). */
export function relationTypeCounts(
  relations: KnowledgeGraph["relations"]
): TypeCount[] {
  const counts = new Map<string, number>()
  for (const r of relations) {
    for (const t of r.relationType.length ? r.relationType : ["(untyped)"]) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return toSortedCounts(counts)
}

function toSortedCounts(counts: Map<string, number>): TypeCount[] {
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Build force-graph data. One node per entity; any relation endpoint missing
 * from the entity set becomes a lightweight `unresolved` placeholder node so the
 * edge still renders. Degree (incident relations) drives node size.
 */
export function toForceData(graph: KnowledgeGraph): ForceData {
  const nodes = new Map<string, ForceNode>()
  for (const e of graph.entities) {
    nodes.set(e.name, {
      id: e.name,
      name: e.name,
      entityType: e.entityType,
      degree: 0,
      trust: deriveNodeTrust(e.observations),
    })
  }

  const links: ForceLink[] = []
  for (const r of graph.relations) {
    if (!r.from || !r.to) continue
    ensureNode(nodes, r.from)
    ensureNode(nodes, r.to)
    nodes.get(r.from)!.degree++
    nodes.get(r.to)!.degree++
    links.push({
      source: r.from,
      target: r.to,
      relationType: r.relationType,
      trust: deriveRelationTrust(r),
    })
  }

  return { nodes: [...nodes.values()], links }
}

function ensureNode(nodes: Map<string, ForceNode>, name: string): void {
  if (!nodes.has(name)) {
    nodes.set(name, {
      id: name,
      name,
      entityType: "(unresolved)",
      degree: 0,
      unresolved: true,
    })
  }
}
