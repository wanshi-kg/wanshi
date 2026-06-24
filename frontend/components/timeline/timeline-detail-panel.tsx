"use client"

import { useMemo } from "react"
import { History } from "lucide-react"
import type { KnowledgeGraph } from "@/types"
import { cn, formatDate } from "@/lib/utils"
import { deriveObservationTrust } from "@/lib/trust"
import { TrustBadge } from "@/components/trust-badge"
import {
  type TimeAxis,
  obsInterval,
  stateAt,
  entityInterval,
} from "@/lib/timeline"

const STATE_LABEL: Record<string, string> = {
  future: "not yet",
  active: "active",
  superseded: "superseded",
}

/** The right rail: the selected entity's observations and their state at time T. */
export function TimelineDetailPanel({
  graph,
  entityName,
  axis,
  t,
  firstSeen,
}: {
  graph: KnowledgeGraph
  entityName: string | null
  axis: TimeAxis
  t: number
  firstSeen: Map<string, number>
}) {
  const entity = useMemo(
    () => graph.entities.find((e) => e.name === entityName) ?? null,
    [graph, entityName]
  )

  if (!entity) {
    return (
      <aside className="hidden min-h-0 flex-col rounded-xl border bg-card p-4 lg:flex">
        <p className="m-auto max-w-[14rem] text-center text-sm text-muted-foreground">
          <History className="mx-auto mb-2 size-5 opacity-50" />
          Select an entity lane to see how its facts evolve over time.
        </p>
      </aside>
    )
  }

  if (axis === "processing") {
    const seen = firstSeen.get(entity.name)
    return (
      <aside className="min-h-0 overflow-auto rounded-xl border bg-card p-4">
        <h2 className="truncate font-display text-base font-semibold">{entity.name}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{entity.entityType}</p>
        <p className="text-sm">
          First extracted{" "}
          <span className="font-mono">{seen ? formatDate(new Date(seen).toISOString()) : "—"}</span>.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Processing-time shows when the pipeline learned each entity — switch to valid or
          ingestion time to see per-fact validity.
        </p>
      </aside>
    )
  }

  const rows = entity.observations
    .map((o) => ({ o, iv: obsInterval(o, axis), trust: deriveObservationTrust(o) }))
    .filter((r): r is { o: typeof r.o; iv: NonNullable<typeof r.iv>; trust: typeof r.trust } => r.iv !== null)
    .sort((a, b) => (a.iv.start ?? 0) - (b.iv.start ?? 0))

  const iv = entityInterval(entity, axis, firstSeen)
  const entityState = iv ? stateAt(iv, t) : "active"

  return (
    <aside className="min-h-0 overflow-auto rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-display text-base font-semibold">{entity.name}</h2>
          <p className="text-xs text-muted-foreground">{entity.entityType}</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium">
          {STATE_LABEL[entityState]} now
        </span>
      </div>

      <ul className="space-y-2.5">
        {rows.map(({ o, iv, trust }, i) => {
          const st = stateAt(iv, t)
          return (
            <li
              key={i}
              className={cn(
                "rounded-lg border p-2.5 text-sm",
                st === "future" && "opacity-45",
                st === "superseded" && "opacity-70"
              )}
            >
              <div className="mb-1 flex items-center gap-2">
                <TrustBadge signal={trust} />
                <span className="text-[11px] text-muted-foreground">{STATE_LABEL[st]} at T</span>
              </div>
              <p className="leading-snug">{o.text}</p>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {iv.start !== null ? formatDate(new Date(iv.start).toISOString()) : "—"}
                {iv.end !== null && ` → ${formatDate(new Date(iv.end).toISOString())}`}
              </p>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
