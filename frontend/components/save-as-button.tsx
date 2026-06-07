"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Save, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { apiPost } from "@/lib/api"

// Kept in sync with server/exporter.ts EXPORT_FORMATS (client-safe const).
const FORMATS = ["json", "jsonl", "mcp-jsonl", "dot", "kblam", "lora", "graphiti"]

/** Re-export the run's graph into another format and download it. */
export function SaveAsButton({ runId }: { runId: string }) {
  const [busy, setBusy] = useState(false)

  async function save(format: string) {
    setBusy(true)
    try {
      const { content, filename } = await apiPost<{ content: string; filename: string }>(
        `/api/runs/${runId}/export`,
        { format }
      )
      const blob = new Blob([content], { type: "text/plain" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Saved ${filename}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save as
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f} onClick={() => save(f)} className="font-mono text-xs">
            {f}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
