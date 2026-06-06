import { NextResponse } from "next/server"
import { RunRequestSchema } from "@/lib/kg-options"
import { listAllRuns, startRun } from "@/server/run-registry"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json({ runs: listAllRuns() })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = RunRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid run configuration", details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  // Extra config fields imported from YAML ride alongside the known form fields.
  const passthrough =
    body && typeof body.passthrough === "object" && body.passthrough !== null
      ? (body.passthrough as Record<string, unknown>)
      : undefined
  const run = startRun(parsed.data, passthrough)
  return NextResponse.json({ run }, { status: 201 })
}
