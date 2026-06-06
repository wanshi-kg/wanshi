"use client"

import { useMemo } from "react"
import Link from "next/link"
import type { ColumnDef } from "@tanstack/react-table"
import { Network, FileSearch } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { DataTable } from "@/components/data-table/data-table"
import { Button } from "@/components/ui/button"
import { RunStateBadge } from "@/components/run-state-badge"
import { RerunActions } from "@/components/rerun-actions"
import { useRuns } from "@/hooks/use-runs"
import { basename } from "@/lib/utils"
import type { RunListItem } from "@/types"

function formatWhen(ms?: number): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const VIEWABLE = (r: RunListItem) =>
  r.state === "completed" && !!r.output && r.exportFormat !== "dot"

export default function ResultsPage() {
  const { data: runs, isLoading } = useRuns()

  const columns = useMemo<ColumnDef<RunListItem>[]>(
    () => [
      {
        accessorKey: "input",
        header: "Input",
        cell: ({ row }) => (
          <span className="font-medium" title={row.original.input}>
            {row.original.input ? basename(row.original.input) : "—"}
          </span>
        ),
      },
      {
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.model ?? "—"}</span>
        ),
      },
      {
        accessorKey: "exportFormat",
        header: "Format",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.exportFormat ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "entities",
        header: "Entities",
        cell: ({ row }) => <span className="tabular-nums">{row.original.entities}</span>,
      },
      {
        accessorKey: "relations",
        header: "Relations",
        cell: ({ row }) => <span className="tabular-nums">{row.original.relations}</span>,
      },
      {
        accessorKey: "state",
        header: "State",
        cell: ({ row }) => <RunStateBadge state={row.original.state} />,
      },
      {
        id: "ended",
        accessorFn: (r) => r.endedAt ?? r.startedAt,
        header: "When",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatWhen(row.original.endedAt ?? row.original.startedAt)}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => {
          const run = row.original
          const viewable = VIEWABLE(run)
          return (
            <div className="flex justify-end gap-1">
              <RerunActions id={run.id} state={run.state} compact />
              <span className="mx-0.5 w-px self-stretch bg-border" />
              <Button asChild variant="ghost" size="icon-sm" title="Details" disabled={!viewable}>
                <Link href={`/results/${run.id}`}>
                  <FileSearch className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="ghost" size="icon-sm" title="Visualize" disabled={!viewable}>
                <Link href={`/graph?run=${run.id}`}>
                  <Network className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          )
        },
      },
    ],
    []
  )

  return (
    <div>
      <PageHeader
        title="Results"
        description="Browse the knowledge graphs produced by past runs."
      />
      <DataTable
        columns={columns}
        data={runs ?? []}
        loading={isLoading}
        searchKey="input"
        searchPlaceholder="Search input…"
        persistKey="results-runs"
        getRowId={(r) => r.id}
      />
    </div>
  )
}
