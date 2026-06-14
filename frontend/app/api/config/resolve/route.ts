import { NextResponse } from "next/server"
import { resolveAgainstRunDir } from "@/server/run-registry"

export const dynamic = "force-dynamic"

/**
 * Resolve relative paths to absolute against the wanshi run dir. The browser
 * file picker can't see a config file's location, so imported relative paths
 * are resolved here (same base the CLI uses) and shown in the form.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const paths = Array.isArray(body?.paths) ? (body.paths as unknown[]) : null
  if (!paths) {
    return NextResponse.json({ error: "paths[] required" }, { status: 400 })
  }
  const resolved = paths.map((p) =>
    typeof p === "string" ? resolveAgainstRunDir(p) : p
  )
  return NextResponse.json({ resolved })
}
