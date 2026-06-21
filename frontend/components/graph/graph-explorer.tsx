"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { Eye, EyeOff, Maximize2, RotateCcw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { GraphDetailPanel, type Neighbor } from "@/components/graph/graph-detail-panel"
import { entityTypeCounts, toForceData } from "@/lib/graph-stats"
import { colorForType } from "@/lib/graph-colors"
import { cn } from "@/lib/utils"
import type { Entity, ForceData, ForceNode, KnowledgeGraph } from "@/types"

const ForceGraph = dynamic(() => import("@/components/graph/force-graph"), {
  ssr: false,
})

const LABEL_GUARD = 800

function useIsDark(): boolean {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const el = document.documentElement
    const update = () => setDark(el.classList.contains("dark"))
    update()
    const obs = new MutationObserver(update)
    obs.observe(el, { attributes: true, attributeFilter: ["class"] })
    return () => obs.disconnect()
  }, [])
  return dark
}

function endpointId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string)
}

export function GraphExplorer({
  graph,
  runId,
}: {
  graph: KnowledgeGraph
  /** Threaded to the node inspector to enable "view lineage" (trace inspector). */
  runId?: string
}) {
  const isDark = useIsDark()
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<any>(undefined) // eslint-disable-line @typescript-eslint/no-explicit-any
  const [dims, setDims] = useState({ w: 0, h: 0 })

  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [labels, setLabels] = useState(true)

  const entityMap = useMemo(() => {
    const m = new Map<string, Entity>()
    for (const e of graph.entities) m.set(e.name, e)
    return m
  }, [graph])

  const types = useMemo(() => entityTypeCounts(graph.entities), [graph])
  const fullData = useMemo(() => toForceData(graph), [graph])

  const data: ForceData = useMemo(() => {
    if (hiddenTypes.size === 0) return fullData
    const nodes = fullData.nodes.filter((n) => !hiddenTypes.has(n.entityType))
    const keep = new Set(nodes.map((n) => n.id))
    const links = fullData.links.filter(
      (l) => keep.has(endpointId(l.source)) && keep.has(endpointId(l.target))
    )
    return { nodes, links }
  }, [fullData, hiddenTypes])

  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of data.links) {
      const s = endpointId(l.source)
      const t = endpointId(l.target)
      if (!m.has(s)) m.set(s, new Set())
      if (!m.has(t)) m.set(t, new Set())
      m.get(s)!.add(t)
      m.get(t)!.add(s)
    }
    return m
  }, [data])

  const focusId = hoverId ?? selectedId
  const neighborIds = useMemo(() => {
    if (!focusId) return new Set<string>()
    const set = new Set<string>([focusId])
    for (const n of adjacency.get(focusId) ?? []) set.add(n)
    return set
  }, [focusId, adjacency])

  // size to container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() =>
      setDims({ w: el.clientWidth, h: el.clientHeight })
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // reset selection when graph changes
  useEffect(() => {
    setSelectedId(null)
    setHiddenTypes(new Set())
  }, [graph])

  const selectedEntity = selectedId ? entityMap.get(selectedId) : undefined
  const selectedNode = selectedId
    ? data.nodes.find((n) => n.id === selectedId)
    : undefined
  const neighbors: Neighbor[] = useMemo(() => {
    if (!selectedId) return []
    return [...(adjacency.get(selectedId) ?? [])].map((name) => ({
      name,
      entityType: entityMap.get(name)?.entityType ?? "(unresolved)",
    }))
  }, [selectedId, adjacency, entityMap])

  const incidentRelations = useMemo(() => {
    if (!selectedId) return []
    return graph.relations.filter((r) => r.from === selectedId || r.to === selectedId)
  }, [selectedId, graph])

  function focusNode(name: string) {
    const node = data.nodes.find(
      (n) => n.name === name
    ) as (ForceNode & { x?: number; y?: number }) | undefined
    setSelectedId(name)
    if (node && node.x != null && graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 600)
      graphRef.current.zoom(3.5, 600)
    }
  }

  function runSearch() {
    const q = query.trim().toLowerCase()
    if (!q) return
    const node =
      data.nodes.find((n) => n.name.toLowerCase() === q) ??
      data.nodes.find((n) => n.name.toLowerCase().includes(q))
    if (node) focusNode(node.name)
  }

  function toggleType(type: string) {
    setHiddenTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const showLabels = labels && data.nodes.length <= LABEL_GUARD

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-xl border bg-background"
    >
      {/* atmospheric dotted field */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      {/* canvas */}
      {dims.w > 0 && (
        <ForceGraph
          data={data}
          width={dims.w}
          height={dims.h}
          isDark={isDark}
          showLabels={showLabels}
          focusId={focusId}
          neighborIds={neighborIds}
          graphRef={graphRef}
          onNodeClick={(n: ForceNode) => setSelectedId(n.id)}
          onNodeHover={(n: ForceNode | null) => setHoverId(n?.id ?? null)}
          onBackgroundClick={() => setSelectedId(null)}
        />
      )}

      {/* top control bar */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-center justify-between gap-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-card/90 p-1.5 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/70">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Find entity…"
              className="h-8 w-48 pl-8"
            />
          </div>
          <Button
            variant={labels ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => setLabels((v) => !v)}
            title={labels ? "Hide labels" : "Show labels"}
          >
            {labels ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => graphRef.current?.zoomToFit(500, 60)}
            title="Zoom to fit"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setSelectedId(null)
              setHiddenTypes(new Set())
              graphRef.current?.zoomToFit(500, 60)
            }}
            title="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>

        <div className="pointer-events-auto rounded-lg border bg-card/90 px-3 py-1.5 text-xs tabular-nums text-muted-foreground shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/70">
          {data.nodes.length} nodes · {data.links.length} edges
          {!showLabels && labels && data.nodes.length > LABEL_GUARD && (
            <span className="ml-2 text-amber-600">labels off (large graph)</span>
          )}
        </div>
      </div>

      {/* legend */}
      {types.length > 0 && (
        <div className="pointer-events-auto absolute bottom-3 left-3 max-h-[40%] w-56 overflow-auto rounded-lg border bg-card/90 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/70">
          <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Entity types
          </div>
          <ul className="space-y-0.5">
            {types.map((t) => {
              const hidden = hiddenTypes.has(t.type)
              return (
                <li key={t.type}>
                  <button
                    type="button"
                    onClick={() => toggleType(t.type)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent",
                      hidden && "opacity-40"
                    )}
                  >
                    <span
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: colorForType(t.type) }}
                    />
                    <span className="flex-1 truncate text-left">{t.type}</span>
                    <span className="tabular-nums text-muted-foreground">{t.count}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* detail panel */}
      {selectedId && (
        <div className="pointer-events-none absolute bottom-3 right-3 top-16 flex">
          <GraphDetailPanel
            name={selectedId}
            entity={selectedEntity}
            entityType={selectedEntity?.entityType ?? selectedNode?.entityType ?? "(unresolved)"}
            neighbors={neighbors}
            relations={incidentRelations}
            runId={runId}
            onClose={() => setSelectedId(null)}
            onSelectNeighbor={focusNode}
          />
        </div>
      )}
    </div>
  )
}
