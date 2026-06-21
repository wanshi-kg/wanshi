"use client"

import Link from "next/link"
import { X, FileText, GitBranch, ArrowRight, ArrowLeft, ScrollText, Activity } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TypeChip } from "@/components/type-chip"
import { TrustBadge } from "@/components/trust-badge"
import { ObservationItem } from "@/components/graph/observation-item"
import { colorForType } from "@/lib/graph-colors"
import { deriveRelationTrust } from "@/lib/trust"
import { basename } from "@/lib/utils"
import type { Entity, Relation } from "@/types"

export interface Neighbor {
  name: string
  entityType: string
}

/** One incident edge, direction-aware + trust-aware + navigable. */
function RelationRow({
  relation,
  selfName,
  typeOf,
  onSelect,
}: {
  relation: Relation
  selfName: string
  typeOf: (name: string) => string
  onSelect: (name: string) => void
}) {
  const outgoing = relation.from === selfName
  const other = outgoing ? relation.to : relation.from
  const trust = deriveRelationTrust(relation)
  const showTrust = trust.state !== "unknown" || typeof trust.confidence === "number"
  const Dir = outgoing ? ArrowRight : ArrowLeft

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(other)}
        className="w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-accent"
      >
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Dir className="h-3 w-3 shrink-0" />
          <span className="flex flex-wrap gap-x-1.5 font-mono">
            {relation.relationType.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-1.5">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ backgroundColor: colorForType(typeOf(other)) }}
            />
            <span className="truncate text-xs" title={`${other} (${typeOf(other)})`}>
              {other}
            </span>
          </span>
          {showTrust && <TrustBadge signal={trust} showLabel={false} />}
        </div>
      </button>
    </li>
  )
}

export function GraphDetailPanel({
  name,
  entity,
  entityType,
  neighbors,
  relations,
  runId,
  onClose,
  onSelectNeighbor,
}: {
  entity?: Entity
  /** Falls back to this when the node is an unresolved relation endpoint. */
  entityType: string
  neighbors: Neighbor[]
  /** Edges incident to this node (either direction). */
  relations: Relation[]
  /** When present, enables a jump to this node's lineage in the trace inspector. */
  runId?: string
  name: string
  onClose: () => void
  onSelectNeighbor: (name: string) => void
}) {
  const typeMap = new Map(neighbors.map((n) => [n.name, n.entityType]))
  const typeOf = (n: string) => typeMap.get(n) ?? "(unresolved)"

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-semibold leading-tight">{name}</div>
          <TypeChip type={entityType} className="mt-1 text-xs text-muted-foreground" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {runId && (
            <Button asChild variant="ghost" size="icon-sm" title="View lineage in the trace inspector">
              <Link href={`/trace/${runId}?entity=${encodeURIComponent(name)}`}>
                <Activity className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-auto px-4 py-3 text-sm">
        {!entity ? (
          <p className="text-xs text-muted-foreground">
            Unresolved entity — referenced by a relation but not extracted on its own.
          </p>
        ) : (
          <>
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ScrollText className="h-3 w-3" /> Observations ({entity.observations.length})
              </h4>
              {entity.observations.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
              ) : (
                <div className="space-y-2.5">
                  {entity.observations.map((o, i) => (
                    <ObservationItem key={i} observation={o} />
                  ))}
                </div>
              )}
            </section>

            {entity.files.length > 0 && (
              <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <FileText className="h-3 w-3" /> Files
                </h4>
                <ul className="space-y-1">
                  {entity.files.map((f) => (
                    <li key={f} className="truncate font-mono text-xs text-muted-foreground" title={f}>
                      {basename(f)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <section>
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <GitBranch className="h-3 w-3" /> Relations ({relations.length})
          </h4>
          {relations.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-1.5">
              {relations.map((r, i) => (
                <RelationRow
                  key={`${r.from}-${r.to}-${i}`}
                  relation={r}
                  selfName={name}
                  typeOf={typeOf}
                  onSelect={onSelectNeighbor}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
