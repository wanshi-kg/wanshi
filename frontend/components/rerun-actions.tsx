"use client"

import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Play, RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useRerun, type RerunMode } from "@/hooks/use-runs"
import type { RunState } from "@/types"

const TERMINAL: RunState[] = ["completed", "failed", "cancelled"]

/**
 * Resume / Restart buttons for a past run. Resume continues from the checkpoint;
 * Restart deletes it and re-extracts fresh. Both spawn a new run and navigate to
 * its live progress. `compact` renders icon-only (for table rows).
 */
export function RerunActions({
  id,
  state,
  compact,
}: {
  id: string
  state: RunState
  compact?: boolean
}) {
  const router = useRouter()
  const rerun = useRerun()
  const disabled = !TERMINAL.includes(state) || rerun.isPending

  function go(mode: RerunMode) {
    rerun.mutate(
      { id, mode },
      {
        onSuccess: ({ run }) => {
          toast.success(mode === "resume" ? "Resuming run…" : "Restarting run…")
          router.push(`/runs/${run.id}`)
        },
        onError: (e) =>
          toast.error(e instanceof Error ? e.message : "Failed to re-run"),
      }
    )
  }

  const spin = rerun.isPending

  if (compact) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Resume (continue from checkpoint)"
          disabled={disabled}
          onClick={() => go("resume")}
        >
          {spin ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Restart (fresh re-extract)"
          disabled={disabled}
          onClick={() => go("restart")}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </>
    )
  }

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => go("resume")}>
        {spin ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        Resume
      </Button>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => go("restart")}>
        <RefreshCw className="h-4 w-4" />
        Restart
      </Button>
    </div>
  )
}
