"use client"

import ForceGraph2D from "react-force-graph-2d"
import type { ForceData, ForceNode, TrustSignal } from "@/types"
import { colorForType, trustColor, resolveToken } from "@/lib/graph-colors"

// react-force-graph mutates nodes/links with x/y and resolved source/target
// objects, so the canvas callbacks work in `any` space by design.
/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
  data: ForceData
  width: number
  height: number
  isDark: boolean
  showLabels: boolean
  focusId: string | null
  neighborIds: Set<string>
  graphRef: React.MutableRefObject<any>
  onNodeClick: (node: ForceNode) => void
  onNodeHover: (node: ForceNode | null) => void
  onBackgroundClick: () => void
}

function radius(node: any): number {
  return Math.min(11, 2.6 + Math.sqrt(node.degree || 0) * 1.15)
}

function endpointId(end: any): string {
  return typeof end === "object" ? end.id : end
}

export default function ForceGraphInner({
  data,
  width,
  height,
  isDark,
  showLabels,
  focusId,
  neighborIds,
  graphRef,
  onNodeClick,
  onNodeHover,
  onBackgroundClick,
}: Props) {
  const text = resolveToken("--color-foreground") || (isDark ? "#ededed" : "#171717")
  const muted = isDark ? "rgba(237,237,237,0.5)" : "rgba(23,23,23,0.45)"
  const baseLink = isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.12)"
  const strongLink = isDark ? "rgba(237,237,237,0.6)" : "rgba(23,23,23,0.55)"

  const linkActive = (l: any) =>
    focusId != null && (endpointId(l.source) === focusId || endpointId(l.target) === focusId)
  const dimmed = (id: string) => focusId != null && !neighborIds.has(id)

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      nodeId="id"
      nodeRelSize={1}
      nodeLabel={(n: any) => n.name}
      linkLabel={(l: any) =>
        Array.isArray(l.relationType) ? l.relationType.join(", ") : ""
      }
      cooldownTicks={120}
      onEngineStop={() => graphRef.current?.zoomToFit?.(400, 60)}
      onNodeClick={(n: any) => onNodeClick(n)}
      onNodeHover={(n: any) => onNodeHover(n ?? null)}
      onBackgroundClick={onBackgroundClick}
      linkColor={(l: any) => {
        const t: TrustSignal | undefined = l.trust
        // Surface unfaithful / ungrounded edges regardless of focus.
        if (t && (t.state === "ungrounded" || t.state === "uncertain")) return trustColor(t.state)
        return linkActive(l) ? strongLink : baseLink
      }}
      linkWidth={(l: any) => (linkActive(l) ? 1.6 : 0.6)}
      linkDirectionalArrowLength={3}
      linkDirectionalArrowRelPos={1}
      linkDirectionalParticles={(l: any) => (linkActive(l) ? 2 : 0)}
      linkDirectionalParticleWidth={1.7}
      nodeCanvasObject={(node: any, ctx, scale) => {
        const r = radius(node)
        const faded = dimmed(node.id)
        const color = node.unresolved ? muted : colorForType(node.entityType)
        const trust: TrustSignal | undefined = node.trust
        const conf = trust?.confidence

        // Opacity encodes the confidence gradient — an un-scored node (no signal)
        // stays at full opacity rather than fading toward invisible.
        ctx.globalAlpha = faded ? 0.16 : typeof conf === "number" ? 0.45 + 0.55 * conf : 1
        ctx.beginPath()
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()

        // Trust ring: a graded node wears a ring in its trust color (neutral now,
        // semantic once Sable's color-book lands). Skipped for unknown/unresolved.
        if (!faded && trust && trust.state !== "unknown" && !node.unresolved) {
          ctx.globalAlpha = 1
          ctx.lineWidth = 1.5 / scale
          ctx.strokeStyle = trustColor(trust.state)
          ctx.beginPath()
          ctx.arc(node.x, node.y, r + 2 / scale, 0, 2 * Math.PI)
          ctx.stroke()
        }

        if (node.id === focusId) {
          ctx.globalAlpha = 1
          ctx.lineWidth = 2 / scale
          ctx.strokeStyle = text
          ctx.beginPath()
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
          ctx.stroke()
        }

        const focusLabel = node.id === focusId || (focusId != null && neighborIds.has(node.id))
        const show = !faded && (focusLabel || (showLabels && scale > 1.1))
        if (show) {
          const label: string = node.name
          const fontSize = Math.max(10 / scale, 2.4)
          ctx.font = `${fontSize}px 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif`
          ctx.textAlign = "center"
          ctx.textBaseline = "top"
          ctx.fillStyle = text
          ctx.globalAlpha = 0.92
          ctx.fillText(label.length > 26 ? `${label.slice(0, 25)}…` : label, node.x, node.y + r + 1.5)
        }
        ctx.globalAlpha = 1
      }}
      nodePointerAreaPaint={(node: any, color, ctx) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(node.x, node.y, radius(node) + 2, 0, 2 * Math.PI)
        ctx.fill()
      }}
    />
  )
}
