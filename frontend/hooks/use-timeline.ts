"use client"

import { useMemo } from "react"
import { useGraph } from "./use-graph"
import { useTrace } from "./use-trace"
import { axisCoverage, defaultAxis, firstSeenFromTrace, type AxisInfo, type TimeAxis } from "@/lib/timeline"

/**
 * Compose the graph (required) + the trace sidecar (optional — drives the
 * processing-time axis; a 404 just means that axis is unavailable) into the
 * inputs the timeline view needs: the full graph, per-axis coverage, the
 * entity→first-seen map, and the default axis.
 */
export function useTimeline(runId: string | null) {
  const graphQ = useGraph(runId)
  const traceQ = useTrace(runId) // retry:false; 404 → error, treated as "no trace"

  const trace = traceQ.data?.trace
  const firstSeen = useMemo(() => firstSeenFromTrace(trace), [trace])

  const graph = graphQ.data?.graph
  const axes: AxisInfo[] = useMemo(
    () => (graph ? axisCoverage(graph, firstSeen) : []),
    [graph, firstSeen]
  )
  const defaultAxisValue: TimeAxis = useMemo(
    () => (axes.length ? defaultAxis(axes) : "tx"),
    [axes]
  )

  return {
    graph,
    output: graphQ.data?.output,
    trace,
    firstSeen,
    axes,
    defaultAxisValue,
    isLoading: graphQ.isLoading,
    error: graphQ.error,
  }
}
