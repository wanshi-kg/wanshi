/**
 * Pure timeline logic — the testable core of the Phase-C "graph as of date T" view.
 *
 * Three switchable time axes over the same graph:
 *  - valid       — world-time: an observation's `validAt → invalidAt`.
 *  - tx          — ingestion-time: `createdAt → expiredAt`.
 *  - processing  — pipeline wall-clock: an entity's first `extraction` event `ts`
 *                  (from the trace sidecar) → open. "When the graph learned this."
 *
 * No React, no colors, no I/O. Everything time is epoch-ms; `null` = unbounded.
 */
import type { KnowledgeGraph, Entity, Observation } from "@/types"
import type { TraceRecord } from "@/lib/trace"

export type TimeAxis = "valid" | "tx" | "processing"

export const AXIS_LABEL: Record<TimeAxis, string> = {
  valid: "Valid time",
  tx: "Ingestion time",
  processing: "Processing time",
}

export const AXIS_HINT: Record<TimeAxis, string> = {
  valid: "When facts are true in the world (validAt → invalidAt). Needs timestamped sources (chat/email).",
  tx: "When facts were ingested into the graph (createdAt → expiredAt).",
  processing: "When the pipeline first extracted each entity (trace wall-clock). Needs a run with trace enabled.",
}

/** State of an interval relative to the scrubber time T. */
export type TemporalState = "future" | "active" | "superseded"

export interface Interval {
  start: number | null // epoch-ms; null = always-existed (unbounded left)
  end: number | null // epoch-ms; null = still current (open right)
}

export function parseTs(s?: string | null): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** entity name → earliest `extraction` wall-clock (ms), from the trace sidecar. */
export function firstSeenFromTrace(trace: TraceRecord[] | undefined): Map<string, number> {
  const m = new Map<string, number>()
  if (!trace) return m
  for (const r of trace) {
    if (r.type !== "extraction") continue
    const ts = parseTs(r.ts)
    if (ts === null) continue
    for (const em of r.entityMentions ?? []) {
      const prev = m.get(em.name)
      if (prev === undefined || ts < prev) m.set(em.name, ts)
    }
  }
  return m
}

/** An observation's interval on the valid/tx axes (null = no data on this axis). */
export function obsInterval(o: Observation, axis: TimeAxis): Interval | null {
  if (axis === "valid") {
    const start = parseTs(o.validAt)
    if (start === null) return null
    return { start, end: parseTs(o.invalidAt) }
  }
  if (axis === "tx") {
    const start = parseTs(o.createdAt)
    if (start === null) return null
    return { start, end: parseTs(o.expiredAt) }
  }
  return null // processing is entity-level (see entityInterval)
}

/** Where an interval sits relative to T. */
export function stateAt(iv: Interval, t: number): TemporalState {
  if (iv.start !== null && t < iv.start) return "future"
  if (iv.end !== null && t >= iv.end) return "superseded"
  return "active"
}

/**
 * An entity's interval on an axis: the span of its observation intervals
 * (valid/tx), or first-seen → open (processing). null = no data on this axis.
 */
export function entityInterval(
  e: Entity,
  axis: TimeAxis,
  firstSeen: Map<string, number>
): Interval | null {
  if (axis === "processing") {
    const s = firstSeen.get(e.name)
    return s === undefined ? null : { start: s, end: null }
  }
  let start: number | null = null
  let end: number | null = null
  let any = false
  let openEnd = false
  for (const o of e.observations) {
    const iv = obsInterval(o, axis)
    if (!iv) continue
    any = true
    if (iv.start !== null) start = start === null ? iv.start : Math.min(start, iv.start)
    if (iv.end === null) openEnd = true
    else end = end === null ? iv.end : Math.max(end, iv.end)
  }
  if (!any) return null
  return { start, end: openEnd ? null : end }
}

export interface AxisInfo {
  axis: TimeAxis
  label: string
  hint: string
  count: number
  enabled: boolean
}

/** Per-axis data coverage — drives the axis switch (enabled/disabled) + default. */
export function axisCoverage(graph: KnowledgeGraph, firstSeen: Map<string, number>): AxisInfo[] {
  const count: Record<TimeAxis, number> = { valid: 0, tx: 0, processing: firstSeen.size }
  for (const e of graph.entities) {
    for (const o of e.observations) {
      if (o.validAt) count.valid++
      if (o.createdAt) count.tx++
    }
  }
  return (["valid", "tx", "processing"] as TimeAxis[]).map((axis) => ({
    axis,
    label: AXIS_LABEL[axis],
    hint: AXIS_HINT[axis],
    count: count[axis],
    enabled: count[axis] > 0,
  }))
}

/** Default axis: valid is most meaningful, processing next, tx the flat fallback. */
export function defaultAxis(infos: AxisInfo[]): TimeAxis {
  for (const a of ["valid", "processing", "tx"] as TimeAxis[]) {
    if (infos.find((i) => i.axis === a)?.enabled) return a
  }
  return "tx"
}

/** [min, max] epoch-ms across every entity interval on the axis (scrubber range). */
export function timeDomain(
  graph: KnowledgeGraph,
  axis: TimeAxis,
  firstSeen: Map<string, number>
): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const e of graph.entities) {
    const iv = entityInterval(e, axis, firstSeen)
    if (!iv) continue
    for (const ms of [iv.start, iv.end]) {
      if (ms === null) continue
      lo = Math.min(lo, ms)
      hi = Math.max(hi, ms)
    }
  }
  if (lo === Infinity) return null
  if (hi <= lo) hi = lo + 1 // avoid a zero-width domain
  return [lo, hi]
}

/** Count entities with at least one `active` observation at T (the "as of T" size). */
export function activeEntityCount(
  graph: KnowledgeGraph,
  axis: TimeAxis,
  firstSeen: Map<string, number>,
  t: number
): number {
  let n = 0
  for (const e of graph.entities) {
    const iv = entityInterval(e, axis, firstSeen)
    if (iv && stateAt(iv, t) === "active") n++
  }
  return n
}
