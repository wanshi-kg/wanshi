import {
  ShieldCheck,
  ShieldX,
  ShieldQuestion,
  GitCompare,
  History,
  ScanLine,
  CircleHelp,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { trustVar } from "@/lib/graph-colors"
import { trustLabel, type TrustSignal, type TrustState } from "@/lib/trust"

/**
 * A trust state pill — icon + label, colored by the `--color-trust-*` seam.
 * The ICON (not just color) carries the state, so it stays readable while the
 * placeholder palette is neutral and after Sable's color-book lands.
 */
const ICON: Record<TrustState, LucideIcon> = {
  grounded: ShieldCheck,
  ungrounded: ShieldX,
  uncertain: ShieldQuestion,
  contradicted: GitCompare,
  superseded: History,
  "tool-derived": ScanLine,
  unknown: CircleHelp,
}

export function TrustBadge({
  signal,
  showLabel = true,
  className,
}: {
  signal: TrustSignal
  showLabel?: boolean
  className?: string
}) {
  const { state, confidence } = signal
  const Icon = ICON[state]
  const color = trustVar(state)
  const pct = typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : null
  const title = pct ? `${trustLabel(state)} · confidence ${pct}` : trustLabel(state)

  return (
    <span
      title={title}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-2 py-0.5 text-[11px] font-semibold text-foreground",
        className
      )}
      style={{
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden="true" />
      {showLabel && <span className="font-display">{trustLabel(state)}</span>}
      {pct && (
        <span className="font-mono tabular-nums" style={{ color }}>
          {pct}
        </span>
      )}
    </span>
  )
}
