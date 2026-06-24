"use client"

import { useMemo } from "react"
import type { KnowledgeGraph, TrustState } from "@/types"
import { cn, formatDate } from "@/lib/utils"
import { trustVar } from "@/lib/graph-colors"
import { trustLabel } from "@/lib/trust"
import {
  type AxisInfo,
  type TimeAxis,
  activeEntityCount,
} from "@/lib/timeline"

/** Axis switch + time scrubber + trust-state filter + the "as of T" summary. */
export function TimelineControls({
  axes,
  axis,
  onAxis,
  domain,
  t,
  onT,
  presentStates,
  visible,
  onToggleState,
  graph,
  firstSeen,
}: {
  axes: AxisInfo[]
  axis: TimeAxis
  onAxis: (a: TimeAxis) => void
  domain: [number, number] | null
  t: number
  onT: (t: number) => void
  presentStates: TrustState[]
  visible: Set<TrustState>
  onToggleState: (s: TrustState) => void
  graph: KnowledgeGraph
  firstSeen: Map<string, number>
}) {
  const active = useMemo(
    () => activeEntityCount(graph, axis, firstSeen, t),
    [graph, axis, firstSeen, t]
  )
  const isoAtT = useMemo(() => new Date(t).toISOString(), [t])

  return (
    <div className="space-y-3 rounded-xl border bg-card p-3">
      {/* axis switch */}
      <div className="flex flex-wrap items-center gap-1.5">
        {axes.map((a) => (
          <button
            key={a.axis}
            type="button"
            disabled={!a.enabled}
            title={a.enabled ? a.hint : `${a.hint} — no data in this run.`}
            onClick={() => a.enabled && onAxis(a.axis)}
            className={cn(
              "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
              a.axis === axis
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
              !a.enabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground"
            )}
          >
            {a.label}
            <span className="ml-1.5 font-mono tabular-nums opacity-60">{a.count}</span>
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          <span className="font-mono tabular-nums text-foreground">{active}</span> entities active
        </span>
      </div>

      {/* scrubber */}
      {domain && (
        <div className="space-y-1">
          <input
            type="range"
            min={domain[0]}
            max={domain[1]}
            value={Math.min(Math.max(t, domain[0]), domain[1])}
            step={Math.max(1, Math.floor((domain[1] - domain[0]) / 1000))}
            onChange={(e) => onT(Number(e.target.value))}
            className="w-full accent-primary"
            aria-label="scrub time"
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-mono">{formatDate(new Date(domain[0]).toISOString())}</span>
            <span className="rounded-md bg-muted px-2 py-0.5 font-mono font-semibold text-foreground">
              as of {formatDate(isoAtT)}
            </span>
            <span className="font-mono">{formatDate(new Date(domain[1]).toISOString())}</span>
          </div>
        </div>
      )}

      {/* trust filter (valid/tx axes only — processing has no per-fact trust) */}
      {axis !== "processing" && presentStates.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {presentStates.map((s) => {
            const on = visible.has(s)
            const color = trustVar(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => onToggleState(s)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-opacity",
                  !on && "opacity-35"
                )}
                style={{ borderColor: color, color }}
                title={`${on ? "hide" : "show"} ${trustLabel(s)}`}
              >
                {trustLabel(s)}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
