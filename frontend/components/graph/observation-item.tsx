import { TrustBadge } from "@/components/trust-badge"
import { ProvenanceChip } from "@/components/provenance-chip"
import { deriveObservationTrust } from "@/lib/trust"
import { basename, cn } from "@/lib/utils"
import type { Observation } from "@/types"

function fmtDate(s?: string): string | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString()
}

/**
 * One observation (fact) with its full provenance — the trust state (badge),
 * the source adapter + locator + confidence (chip), and the bi-temporal/source
 * line. Shared by the node inspector and the results table so the two can't
 * drift. Trust/provenance chrome only appears when the fact actually carries it;
 * a plain LLM fact degrades to text + source line (its prior look).
 */
export function ObservationItem({
  observation,
  className,
}: {
  observation: Observation
  className?: string
}) {
  const o = observation
  const trust = deriveObservationTrust(o)
  const showTrust = trust.state !== "unknown" || typeof trust.confidence === "number"

  const meta: string[] = []
  if (o.source) meta.push(basename(o.source))
  if (o.speaker) meta.push(o.speaker)
  const valid = fmtDate(o.validAt)
  const created = fmtDate(o.createdAt)
  if (valid) meta.push(`valid ${valid}`)
  else if (created) meta.push(created)
  const invalid = fmtDate(o.invalidAt) ?? fmtDate(o.expiredAt)
  if (invalid) meta.push(`superseded ${invalid}`)

  const hasChrome = showTrust || o.sourceAdapter || o.locator || typeof o.confidence === "number"

  return (
    <div className={cn("border-l-2 border-border pl-2.5", className)}>
      <p className="leading-snug">{o.text}</p>
      {hasChrome && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {showTrust && <TrustBadge signal={trust} />}
          <ProvenanceChip
            sourceAdapter={o.sourceAdapter}
            locator={o.locator}
            confidence={o.confidence}
          />
        </div>
      )}
      {meta.length > 0 && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.join(" · ")}</p>
      )}
    </div>
  )
}
