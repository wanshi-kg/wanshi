import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { launchCmd, repoCwd } from "@/server/run-registry"

const execFileAsync = promisify(execFile)

export const dynamic = "force-dynamic"

/**
 * The wanshi config schema, fetched from the backend so the frontend never
 * duplicates the option list. We spawn the CLI's `schema` command (the same
 * launch mechanism as a run) and return its `{ jsonSchema, groups,
 * controlledPaths }` payload. The schema only changes when the backend is
 * rebuilt, so cache it in-process across requests.
 */
type SchemaPayload = {
  jsonSchema: Record<string, unknown>
  groups: unknown[]
  controlledPaths: string[]
}

let cached: SchemaPayload | undefined

async function loadSchema(): Promise<SchemaPayload> {
  if (cached) return cached
  const [bin, ...baseArgs] = launchCmd()
  const { stdout } = await execFileAsync(bin, [...baseArgs, "schema", "--json"], {
    cwd: repoCwd(),
    maxBuffer: 8 * 1024 * 1024,
  })
  cached = JSON.parse(stdout) as SchemaPayload
  return cached
}

export async function GET() {
  try {
    const payload = await loadSchema()
    return NextResponse.json(payload)
  } catch (err) {
    return NextResponse.json(
      {
        error:
          "Could not load the config schema from the wanshi CLI. Build the backend (`npm run build` in the repo root), or set WANSHI_CMD.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
