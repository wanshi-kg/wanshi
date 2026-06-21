import { Fingerprint, MapPin } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * ECS source-tagging at a glance: which adapter produced a fact (`sourceAdapter`)
 * and where in the source (`locator`), plus the read-reliability `confidence`.
 * Renders nothing when a fact carries no such provenance (e.g. a plain LLM
 * extraction or an mcp-jsonl graph) — absence is shown elsewhere, not faked here.
 */
export function ProvenanceChip({
  sourceAdapter,
  locator,
  confidence,
  className,
}: {
  sourceAdapter?: string
  locator?: string
  confidence?: number
  className?: string
}) {
  if (!sourceAdapter && !locator && typeof confidence !== "number") return null
  const pct = typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : null

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
        className
      )}
    >
      {sourceAdapter && (
        <span className="inline-flex items-center gap-0.5">
          <Fingerprint className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          {sourceAdapter}
        </span>
      )}
      {locator && (
        <span className="inline-flex items-center gap-0.5 opacity-90">
          <MapPin className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          {locator}
        </span>
      )}
      {pct && (
        <span className="tabular-nums opacity-80" title="read-reliability (not a truth verdict)">
          {pct}
        </span>
      )}
    </span>
  )
}
