"use client"

import { Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, Network, FileSearch } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { GraphExplorer } from "@/components/graph/graph-explorer"
import { useGraph } from "@/hooks/use-graph"
import { useRuns } from "@/hooks/use-runs"
import { ApiError } from "@/lib/api"
import { basename } from "@/lib/utils"

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[calc(100dvh-9rem)] items-center justify-center">{children}</div>
}

function GraphView({ runId }: { runId: string }) {
  const { data, isLoading, error } = useGraph(runId)

  if (isLoading) {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </Centered>
    )
  }
  if (error || !data) {
    const status = error instanceof ApiError ? error.status : undefined
    return (
      <Centered>
        <Card className="max-w-md">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {status === 422
              ? "This run was exported as GraphViz DOT, which can't be visualized here. Re-run with a json/jsonl export."
              : error instanceof Error
                ? error.message
                : "Graph not available."}
          </CardContent>
        </Card>
      </Centered>
    )
  }

  return (
    <div className="flex h-[calc(100dvh-9rem)] flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">Graph</h1>
          <p className="truncate text-xs text-muted-foreground">
            {basename(data.output)} · {data.graph.entities.length} entities ·{" "}
            {data.graph.relations.length} relations
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/results/${runId}`}>
            <FileSearch className="h-4 w-4" />
            Details
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <GraphExplorer graph={data.graph} runId={runId} />
      </div>
    </div>
  )
}

function RunPicker() {
  const router = useRouter()
  const { data: runs } = useRuns()
  const viewable = (runs ?? []).filter(
    (r) => r.state === "completed" && !!r.output && r.exportFormat !== "dot"
  )

  return (
    <div>
      <PageHeader title="Graph" description="Visualize a run's knowledge graph." />
      <Centered>
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4 py-8 text-center">
            <Network className="mx-auto h-8 w-8 text-muted-foreground" />
            {viewable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No viewable graphs yet.{" "}
                <Link href="/run" className="underline underline-offset-4">
                  Start a run
                </Link>{" "}
                to explore one.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Pick a run to visualize.</p>
                <Select onValueChange={(id) => router.push(`/graph?run=${id}`)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a run…" />
                  </SelectTrigger>
                  <SelectContent>
                    {viewable.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.input ? basename(r.input) : r.id} · {r.entities}e/{r.relations}r
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Link
                  href="/results"
                  className="block text-xs text-muted-foreground underline underline-offset-4"
                >
                  or browse all results
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      </Centered>
    </div>
  )
}

function GraphPageInner() {
  const runId = useSearchParams().get("run")
  return runId ? <GraphView runId={runId} /> : <RunPicker />
}

export default function GraphPage() {
  return (
    <Suspense
      fallback={
        <Centered>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Centered>
      }
    >
      <GraphPageInner />
    </Suspense>
  )
}
