import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import type { StoredRun } from "@/types"

/**
 * Durable run history. Each run is its own JSON file under a cwd-INDEPENDENT
 * directory (default ~/.wanshi/runs), so history survives a server restart no
 * matter where the app is launched from — and a corrupt write loses one run,
 * not all of them. Override the location with WANSHI_DATA_DIR.
 */
function dataDir(): string {
  return process.env.WANSHI_DATA_DIR || path.join(os.homedir(), ".wanshi")
}
function runsDir(): string {
  return path.join(dataDir(), "runs")
}
function runFile(id: string): string {
  return path.join(runsDir(), `${id}.json`)
}

/** Persist a run atomically (temp file + rename). Failures are logged, not hidden. */
export function recordRun(stored: StoredRun): void {
  const dir = runsDir()
  const file = runFile(stored.summary.id)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(stored, null, 2))
    renameSync(tmp, file)
  } catch (err) {
    console.error(
      `[run-store] failed to persist run ${stored.summary.id} to ${file}:`,
      err
    )
  }
}

export function listStoredRuns(): StoredRun[] {
  const dir = runsDir()
  if (!existsSync(dir)) return []
  const out: StoredRun[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(dir, name), "utf-8")
      ) as StoredRun
      if (parsed?.summary?.id) out.push(parsed)
    } catch (err) {
      console.warn(`[run-store] skipping unreadable run file ${name}:`, err)
    }
  }
  return out
}

export function getStoredRun(id: string): StoredRun | undefined {
  const file = runFile(id)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as StoredRun
  } catch {
    return undefined
  }
}
