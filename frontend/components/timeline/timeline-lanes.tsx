"use client"

import { useMemo } from "react"
import type { Entity, KnowledgeGraph } from "@/types"
import { deriveObservationTrust } from "@/lib/trust"
import { trustColor, colorForType } from "@/lib/graph-colors"
import {
  type TimeAxis,
  type Interval,
  obsInterval,
  entityInterval,
  stateAt,
} from "@/lib/timeline"
import type { TrustState } from "@/types"

// Virtual SVG coordinate space (scales to the container via viewBox).
const W = 1000
const GUTTER = 172 // left label column
const PAD_R = 16
const LANE_H = 22
const PAD_T = 10

interface Segment {
  start: number
  end: number | null
  color: string
  superseded: boolean
}

/**
 * The timeline lanes: one row per entity, time on x. valid/tx axes draw each
 * observation's validity interval (colored by its trust state, faded when
 * superseded); the processing axis draws a single first-seen → open bar per
 * entity. A dashed line marks the scrubber time T; entities still in the future
 * at T are dimmed. Read-only — the scrubber lives in the controls.
 */
export function TimelineLanes({
  graph,
  axis,
  firstSeen,
  domain,
  t,
  visibleStates,
  selected,
  onSelect,
}: {
  graph: KnowledgeGraph
  axis: TimeAxis
  firstSeen: Map<string, number>
  domain: [number, number]
  t: number
  visibleStates: Set<TrustState>
  selected: string | null
  onSelect: (name: string) => void
}) {
  const [lo, hi] = domain
  const x = (ms: number) => GUTTER + ((ms - lo) / (hi - lo)) * (W - GUTTER - PAD_R)

  const rows = useMemo(() => {
    return graph.entities
      .map((e) => ({ e, iv: entityInterval(e, axis, firstSeen) }))
      .filter((r): r is { e: Entity; iv: Interval } => r.iv !== null)
      .sort((a, b) => (a.iv.start ?? lo) - (b.iv.start ?? lo))
  }, [graph, axis, firstSeen, lo])

  const H = PAD_T * 2 + Math.max(rows.length, 1) * LANE_H
  const tx = x(t)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="timeline">
      {/* scrubber */}
      <line x1={tx} x2={tx} y1={0} y2={H} stroke="currentColor" strokeWidth={1} opacity={0.45} strokeDasharray="3 3" />
      {rows.map(({ e, iv }, i) => {
        const y = PAD_T + i * LANE_H
        const future = iv.start !== null && t < iv.start
        const sel = e.name === selected

        let segs: Segment[]
        if (axis === "processing") {
          segs = [
            {
              start: iv.start as number,
              end: null,
              color: colorForType(e.entityType),
              superseded: false,
            },
          ]
        } else {
          segs = e.observations
            .map((o): Segment | null => {
              const oi = obsInterval(o, axis)
              if (!oi || oi.start === null) return null
              const st = deriveObservationTrust(o)
              if (!visibleStates.has(st.state)) return null
              return {
                start: oi.start,
                end: oi.end,
                color: trustColor(st.state),
                superseded: stateAt(oi, t) === "superseded",
              }
            })
            .filter((s): s is Segment => s !== null)
          if (segs.length === 0) return null
        }

        return (
          <g
            key={e.name}
            onClick={() => onSelect(e.name)}
            style={{ cursor: "pointer" }}
            opacity={future ? 0.32 : 1}
          >
            <rect x={0} y={y} width={W} height={LANE_H} fill={sel ? "currentColor" : "transparent"} fillOpacity={sel ? 0.06 : 0} />
            <text
              x={GUTTER - 10}
              y={y + LANE_H / 2}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="currentColor"
              opacity={0.85}
            >
              {e.name.length > 28 ? e.name.slice(0, 27) + "…" : e.name}
            </text>
            {segs.map((s, j) => {
              const xa = x(s.start)
              const xb = s.end !== null ? x(s.end) : W - PAD_R
              return (
                <rect
                  key={j}
                  x={xa}
                  y={y + 4}
                  width={Math.max(2.5, xb - xa)}
                  height={LANE_H - 9}
                  rx={3}
                  fill={s.color}
                  fillOpacity={s.superseded ? 0.28 : 0.82}
                  stroke={s.color}
                  strokeOpacity={s.superseded ? 0.5 : 0}
                  strokeDasharray={s.superseded ? "2 2" : undefined}
                />
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}
