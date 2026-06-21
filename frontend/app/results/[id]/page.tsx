"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import type { ColumnDef, Row } from "@tanstack/react-table"
import { ChevronRight, Network, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DataTable } from "@/components/data-table/data-table"
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter"
import { TypeBarChart } from "@/components/charts/type-bar-chart"
import { TypeChip } from "@/components/type-chip"
import { ObservationItem } from "@/components/graph/observation-item"
import { RerunActions } from "@/components/rerun-actions"
import { SaveAsButton } from "@/components/save-as-button"
import { useGraph } from "@/hooks/use-graph"
import { ApiError } from "@/lib/api"
import { basename, cn } from "@/lib/utils"
import { entityTypeCounts, relationTypeCounts } from "@/lib/graph-stats"
import type { Entity, Relation } from "@/types"

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  )
}

function multiSelectFilter(rowValue: string | string[], filter: string[]): boolean {
  if (Array.isArray(rowValue)) return filter.some((v) => rowValue.includes(v))
  return filter.includes(rowValue)
}

export default function ResultDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, error } = useGraph(id)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const graph = data?.graph
  const entityTypes = useMemo(() => entityTypeCounts(graph?.entities ?? []), [graph])
  const relationTypes = useMemo(
    () => relationTypeCounts(graph?.relations ?? []),
    [graph]
  )

  const entityColumns = useMemo<ColumnDef<Entity>[]>(
    () => [
      {
        id: "expander",
        enableHiding: false,
        cell: ({ row }) => (
          <button
            type="button"
            className="flex size-5 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(row.id)) next.delete(row.id)
                else next.add(row.id)
                return next
              })
            }
          >
            <ChevronRight
              className={cn("h-4 w-4 transition-transform", expanded.has(row.id) && "rotate-90")}
            />
          </button>
        ),
      },
      { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      {
        accessorKey: "entityType",
        header: "Type",
        cell: ({ row }) => <TypeChip type={row.original.entityType} className="text-xs" />,
        filterFn: (row, id, value: string[]) =>
          multiSelectFilter(row.getValue(id) as string, value),
      },
      {
        id: "obs",
        accessorFn: (e) => e.observations.length,
        header: "Obs",
        cell: ({ row }) => <span className="tabular-nums">{row.original.observations.length}</span>,
      },
      {
        id: "files",
        accessorFn: (e) => e.files.length,
        header: "Files",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground" title={row.original.files.join("\n")}>
            {row.original.files.length}
          </span>
        ),
      },
    ],
    [expanded]
  )

  const relationColumns = useMemo<ColumnDef<Relation>[]>(
    () => [
      { accessorKey: "from", header: "From", cell: ({ row }) => <span className="font-mono text-xs">{row.original.from}</span> },
      { accessorKey: "to", header: "To", cell: ({ row }) => <span className="font-mono text-xs">{row.original.to}</span> },
      {
        id: "relationType",
        accessorFn: (r) => r.relationType,
        header: "Type",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1.5">
            {row.original.relationType.map((t) => (
              <TypeChip key={t} type={t} className="text-xs" />
            ))}
          </div>
        ),
        filterFn: (row, id, value: string[]) =>
          multiSelectFilter(row.getValue(id) as string[], value),
      },
    ],
    []
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !graph) {
    const status = error instanceof ApiError ? error.status : undefined
    return (
      <div>
        <PageHeader title="Results" />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {status === 422
              ? "This run was exported as GraphViz DOT, which can't be viewed here. Re-run with a json/jsonl export."
              : (error instanceof Error ? error.message : "Graph not available.")}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={`Graph ${id}`}
        description={data?.output ? basename(data.output) : undefined}
        actions={
          <div className="flex items-center gap-2">
            <RerunActions id={id} state="completed" />
            <SaveAsButton runId={id} />
            <Button asChild size="sm">
              <Link href={`/graph?run=${id}`}>
                <Network className="h-4 w-4" />
                Visualize
              </Link>
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="entities" value={graph.entities.length} />
        <Stat label="relations" value={graph.relations.length} />
        <Stat label="entity types" value={entityTypes.length} />
        <Stat label="relation types" value={relationTypes.length} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Entity types</CardTitle></CardHeader>
          <CardContent><TypeBarChart data={entityTypes} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Relation types</CardTitle></CardHeader>
          <CardContent><TypeBarChart data={relationTypes} /></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="entities">
        <TabsList>
          <TabsTrigger value="entities">Entities ({graph.entities.length})</TabsTrigger>
          <TabsTrigger value="relations">Relations ({graph.relations.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="entities" className="mt-4">
          <DataTable
            columns={entityColumns}
            data={graph.entities}
            searchKey="name"
            searchPlaceholder="Search entities…"
            persistKey="results-entities"
            getRowId={(e) => e.name}
            toolbar={(table) => (
              <DataTableFacetedFilter
                column={table.getColumn("entityType")}
                title="Type"
                options={entityTypes.map((t) => ({ label: t.type, value: t.type }))}
              />
            )}
            rowExpansion={{
              expandedRowIds: expanded,
              onToggleRow: (rowId) =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  if (next.has(rowId)) next.delete(rowId)
                  else next.add(rowId)
                  return next
                }),
              renderContent: (row: Row<Entity>) => (
                <div className="space-y-2.5 pl-7 text-sm">
                  {row.original.observations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No observations.</p>
                  ) : (
                    row.original.observations.map((o, i) => (
                      <ObservationItem key={i} observation={o} />
                    ))
                  )}
                </div>
              ),
            }}
          />
        </TabsContent>

        <TabsContent value="relations" className="mt-4">
          <DataTable
            columns={relationColumns}
            data={graph.relations}
            searchKey="from"
            searchPlaceholder="Search source entity…"
            persistKey="results-relations"
            toolbar={(table) => (
              <DataTableFacetedFilter
                column={table.getColumn("relationType")}
                title="Type"
                options={relationTypes.map((t) => ({ label: t.type, value: t.type }))}
              />
            )}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
