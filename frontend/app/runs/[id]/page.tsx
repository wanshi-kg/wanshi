"use client"

import { useEffect, useRef, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import { Ban, CheckCircle2, FileText, Loader2 } from "lucide-react"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RunStateBadge } from "@/components/run-state-badge"
import { useRunStream } from "@/hooks/use-run-stream"
import { cancelRun } from "@/hooks/use-runs"
import { basename, formatDuration } from "@/lib/utils"
import type { RunState } from "@/types"

const TERMINAL: RunState[] = ["completed", "failed", "cancelled"]

function useElapsed(startedAt?: number, endedAt?: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endedAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [endedAt])
  if (!startedAt) return 0
  return ((endedAt ?? now) - startedAt) / 1000
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { summary, logs, connected } = useRunStream(id)
  const [cancelling, setCancelling] = useState(false)

  const elapsed = useElapsed(summary?.startedAt, summary?.endedAt)
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const state = summary?.state ?? "pending"
  const terminal = TERMINAL.includes(state)
  const filesPct =
    summary && summary.filesTotal > 0
      ? Math.round((summary.filesDone / summary.filesTotal) * 100)
      : 0
  const chunkPct =
    summary && summary.chunkTotal && summary.chunkTotal > 0
      ? Math.round(((summary.chunk ?? 0) / summary.chunkTotal) * 100)
      : 0

  async function onCancel() {
    setCancelling(true)
    try {
      const ok = await cancelRun(id)
      toast[ok ? "message" : "error"](
        ok ? "Stopping after the current chunk…" : "Run already finished"
      )
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div>
      <PageHeader
        title={`Run ${id}`}
        description={
          summary?.currentFile && !terminal
            ? basename(summary.currentFile)
            : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <RunStateBadge state={state} />
            {!terminal && (
              <Button
                variant="destructive"
                size="sm"
                onClick={onCancel}
                disabled={cancelling}
              >
                {cancelling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Ban className="h-4 w-4" />
                )}
                Cancel
              </Button>
            )}
          </div>
        }
      />

      <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
        {/* Progress */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>Progress</span>
              <span className="text-xs font-normal text-muted-foreground">
                {connected ? "live" : terminal ? "finished" : "connecting…"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Files</span>
                <span className="tabular-nums">
                  {summary?.filesDone ?? 0} / {summary?.filesTotal ?? 0}
                </span>
              </div>
              <Progress value={filesPct} />
            </div>

            {summary?.currentFile && !terminal && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="truncate text-muted-foreground">
                    {basename(summary.currentFile)}
                  </span>
                  <span className="tabular-nums">
                    chunk {summary.chunk ?? 0} / {summary.chunkTotal ?? 0}
                  </span>
                </div>
                <Progress value={chunkPct} className="h-1.5" />
              </div>
            )}

            <div className="grid grid-cols-3 gap-4 pt-1">
              <Stat label="entities" value={summary?.entities ?? 0} />
              <Stat label="relations" value={summary?.relations ?? 0} />
              <Stat label="elapsed" value={formatDuration(elapsed)} />
            </div>

            {state === "completed" && summary?.output && (
              <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{summary.output}</span>
              </div>
            )}
            {state === "cancelled" && (
              <p className="text-sm text-muted-foreground">
                Cancelled — a partial graph was written to{" "}
                <span className="font-mono text-xs">{summary?.output}</span>.
              </p>
            )}
            {state === "failed" && summary?.error && (
              <p className="text-sm text-destructive">{summary.error}</p>
            )}
          </CardContent>
        </Card>

        {/* Log tail */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Log</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              ref={logRef}
              className="h-72 min-w-0 overflow-y-auto overflow-x-hidden rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed"
            >
              {logs.length === 0 ? (
                <span className="text-muted-foreground">Waiting for output…</span>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    <span
                      className={
                        l.level === "error"
                          ? "text-destructive"
                          : l.level === "warn"
                            ? "text-amber-600"
                            : "text-muted-foreground"
                      }
                    >
                      {l.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
