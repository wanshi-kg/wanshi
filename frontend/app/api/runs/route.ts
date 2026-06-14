import { NextResponse } from "next/server"
import { getPath } from "@/lib/config-schema"
import type { KgGenConfig } from "@/lib/kg-options"
import { listAllRuns, startRun } from "@/server/run-registry"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({ runs: listAllRuns() })
}

/**
 * Start a run from a nested wanshi config (the same shape the CLI validates).
 * We do a light presence check here for a fast 400; the CLI is the authority on
 * full schema validation (and will reject anything malformed at launch).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Config must be a JSON object" }, { status: 400 })
  }
  const config = body as KgGenConfig
  const missing: string[] = []
  if (!getPath(config, "input")) missing.push("input")
  if (!getPath(config, "output")) missing.push("output")
  if (!getPath(config, "llm.model")) missing.push("llm.model")
  if (missing.length) {
    return NextResponse.json(
      { error: `Missing required config: ${missing.join(", ")}` },
      { status: 400 }
    )
  }
  const run = startRun(config)
  return NextResponse.json({ run }, { status: 201 })
}
