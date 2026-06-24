"use client"

import { Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, History } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TimelineView } from "@/components/timeline/timeline-view"
import { useRuns } from "@/hooks/use-runs"
import { basename } from "@/lib/utils"

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-[calc(100dvh-9rem)] items-center justify-center">{children}</div>
}

function RunPicker() {
  const router = useRouter()
  const { data: runs } = useRuns()
  const viewable = (runs ?? []).filter(
    (r) => r.state === "completed" && !!r.output && r.exportFormat !== "dot"
  )

  return (
    <div>
      <PageHeader title="Timeline" description="Scrub through time — the graph as of date T." />
      <Centered>
        <Card className="w-full max-w-md">
          <CardContent className="space-y-4 py-8 text-center">
            <History className="mx-auto h-8 w-8 text-muted-foreground" />
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
                <p className="text-sm text-muted-foreground">Pick a run to scrub through time.</p>
                <Select onValueChange={(id) => router.push(`/timeline?run=${id}`)}>
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
              </>
            )}
          </CardContent>
        </Card>
      </Centered>
    </div>
  )
}

function TimelinePageInner() {
  const runId = useSearchParams().get("run")
  if (!runId) return <RunPicker />
  return (
    <div className="flex h-[calc(100dvh-9rem)] flex-col gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Timeline</h1>
        <p className="text-xs text-muted-foreground">The graph as of date T — switch axis, scrub time.</p>
      </div>
      <div className="min-h-0 flex-1">
        <TimelineView runId={runId} />
      </div>
    </div>
  )
}

export default function TimelinePage() {
  return (
    <Suspense
      fallback={
        <Centered>
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </Centered>
      }
    >
      <TimelinePageInner />
    </Suspense>
  )
}
