"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import type { TrustState } from "@/types"
import { Card, CardContent } from "@/components/ui/card"
import { useTimeline } from "@/hooks/use-timeline"
import { deriveObservationTrust } from "@/lib/trust"
import { type TimeAxis, timeDomain } from "@/lib/timeline"
import { TimelineControls } from "./timeline-controls"
import { TimelineLanes } from "./timeline-lanes"
import { TimelineDetailPanel } from "./timeline-detail-panel"

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[calc(100dvh-9rem)] items-center justify-center">{children}</div>
}

export function TimelineView({ runId }: { runId: string }) {
  const { graph, axes, firstSeen, defaultAxisValue, isLoading, error } = useTimeline(runId)

  const [axisOverride, setAxisOverride] = useState<TimeAxis | null>(null)
  const axis = axisOverride ?? defaultAxisValue

  const domain = useMemo(
    () => (graph ? timeDomain(graph, axis, firstSeen) : null),
    [graph, axis, firstSeen]
  )

  const [t, setT] = useState<number | null>(null)
  // Reset the scrubber to "now" (the domain's right edge) whenever the axis/domain
  // changes. `domain` is memoized, so its identity is stable across scrubs.
  useEffect(() => {
    if (domain) setT(domain[1])
  }, [domain])
  const effT = t ?? (domain ? domain[1] : 0)

  const presentStates = useMemo<TrustState[]>(() => {
    if (!graph) return []
    const order: TrustState[] = ["grounded", "unknown", "tool-derived", "uncertain", "ungrounded", "superseded", "contradicted"]
    const seen = new Set<TrustState>()
    for (const e of graph.entities) for (const o of e.observations) seen.add(deriveObservationTrust(o).state)
    return order.filter((s) => seen.has(s))
  }, [graph])

  const [visible, setVisible] = useState<Set<TrustState>>(new Set())
  useEffect(() => setVisible(new Set(presentStates)), [presentStates])
  const toggleState = (s: TrustState) =>
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  const [selected, setSelected] = useState<string | null>(null)

  if (isLoading) {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Centered>
    )
  }
  if (error || !graph) {
    return (
      <Centered>
        <Card className="max-w-md">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Graph not available."}
          </CardContent>
        </Card>
      </Centered>
    )
  }

  return (
    <div className="grid h-[calc(100dvh-9rem)] grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1">
      <div className="flex min-h-0 flex-col gap-3">
        <TimelineControls
          axes={axes}
          axis={axis}
          onAxis={setAxisOverride}
          domain={domain}
          t={effT}
          onT={setT}
          presentStates={presentStates}
          visible={visible}
          onToggleState={toggleState}
          graph={graph}
          firstSeen={firstSeen}
        />
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card p-2 text-muted-foreground">
          {domain ? (
            <TimelineLanes
              graph={graph}
              axis={axis}
              firstSeen={firstSeen}
              domain={domain}
              t={effT}
              visibleStates={visible}
              selected={selected}
              onSelect={setSelected}
            />
          ) : (
            <p className="p-8 text-center text-sm">No time data on this axis for this run.</p>
          )}
        </div>
      </div>
      <TimelineDetailPanel
        graph={graph}
        entityName={selected}
        axis={axis}
        t={effT}
        firstSeen={firstSeen}
      />
    </div>
  )
}
