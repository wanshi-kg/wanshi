import { readFileSync } from "node:fs"
import type {
  Entity,
  KnowledgeGraph,
  Observation,
  Relation,
} from "@/types"

/** Thrown for formats that can't be parsed back into a structured graph (.dot). */
export class UnsupportedFormatError extends Error {}

/**
 * Load a wanshi output file and normalize it into a {@link KnowledgeGraph},
 * regardless of which export format wrote it:
 *  - .json        → a single { entities, relations } object
 *  - .jsonl       → type-prefixed lines, rich observations
 *  - .mcp-jsonl   → type-prefixed lines; observations are bare strings and
 *                   relationType is a comma-joined string (flattened by MCP)
 *  - .dot         → not round-trippable → UnsupportedFormatError
 */
export function loadGraph(filePath: string): KnowledgeGraph {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".dot")) {
    throw new UnsupportedFormatError(
      "GraphViz DOT output can't be parsed back into a graph — re-run with a json/jsonl export to view it."
    )
  }

  const content = readFileSync(filePath, "utf-8")
  const graph = lower.endsWith(".jsonl") || lower.endsWith(".mcp-jsonl")
    ? parseJsonl(content)
    : parseJson(content)

  return {
    entities: graph.entities.map(normalizeEntity),
    relations: graph.relations.map(normalizeRelation),
  }
}

function parseJson(content: string): KnowledgeGraph {
  const data = JSON.parse(content)
  // A single { entities, relations } object is the norm; tolerate an array of
  // graphs (legacy) by concatenating.
  if (Array.isArray(data)) {
    return data.reduce<KnowledgeGraph>(
      (acc, g) => ({
        entities: [...acc.entities, ...(g.entities ?? [])],
        relations: [...acc.relations, ...(g.relations ?? [])],
      }),
      { entities: [], relations: [] }
    )
  }
  return { entities: data.entities ?? [], relations: data.relations ?? [] }
}

function parseJsonl(content: string): KnowledgeGraph {
  const graph: KnowledgeGraph = { entities: [], relations: [] }
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed)
      if (item.type === "entity") {
        const { type, ...entity } = item
        void type
        graph.entities.push(entity)
      } else if (item.type === "relation") {
        const { type, ...relation } = item
        void type
        graph.relations.push(relation)
      }
    } catch {
      // skip a malformed/truncated line
    }
  }
  return graph
}

function normalizeEntity(e: unknown): Entity {
  const raw = e as Record<string, unknown>
  return {
    name: String(raw.name ?? ""),
    entityType: String(raw.entityType ?? "unknown"),
    observations: normalizeObservations(raw.observations),
    files: Array.isArray(raw.files) ? (raw.files as string[]) : [],
    chunk: typeof raw.chunk === "number" ? raw.chunk : undefined,
    totalChunks: typeof raw.totalChunks === "number" ? raw.totalChunks : undefined,
  }
}

/** Coerce relationType to a string[] (mcp-jsonl flattens it to a comma string). */
function normalizeRelation(r: unknown): Relation {
  const raw = r as Record<string, unknown>
  let relationType: string[] = []
  if (Array.isArray(raw.relationType)) {
    relationType = (raw.relationType as unknown[]).map(String)
  } else if (typeof raw.relationType === "string") {
    relationType = raw.relationType.split(",").map((s) => s.trim()).filter(Boolean)
  }
  return {
    from: String(raw.from ?? ""),
    to: String(raw.to ?? ""),
    relationType,
  }
}

/** A stored observation may be a legacy bare string or a full object. */
function normalizeObservations(arr: unknown): Observation[] {
  if (!Array.isArray(arr)) return []
  return arr.map((o) =>
    typeof o === "string" ? { text: o } : (o as Observation)
  )
}
