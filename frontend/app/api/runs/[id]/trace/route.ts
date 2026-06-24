import { existsSync } from "node:fs"
import { NextResponse } from "next/server"
import { getRunOutput, getRunTracePath } from "@/server/run-registry"
import { loadTrace } from "@/server/trace-loader"

export const dynamic = "force-dynamic"

/**
 * Read a run's debug-trace sidecar (`<output>.trace.jsonl`). Tracing is opt-in
 * (off by default), so a missing sidecar is a meaningful 404 with guidance, not
 * an error — the debug view renders it as "re-run with --trace", same discipline
 * as the graph route's DOT 422.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const output = getRunOutput(id)
  if (!output) {
    return NextResponse.json(
      { error: "No output for this run (not found, still running, or failed)" },
      { status: 404 }
    )
  }
  // Trace sidecars are keyed off the *configured* output, which may differ in
  // extension from the export-rewritten `summary.output` — getRunTracePath
  // reconciles that (and honors an explicit trace.path).
  const tracePath = getRunTracePath(id) ?? `${output}.trace.jsonl`
  if (!existsSync(tracePath)) {
    return NextResponse.json(
      { error: "No trace for this run. Re-run with `--trace` (trace.enabled) to capture one." },
      { status: 404 }
    )
  }
  try {
    const { records, versions } = loadTrace(tracePath)
    return NextResponse.json({ trace: records, versions, path: tracePath })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read trace" },
      { status: 500 }
    )
  }
}
