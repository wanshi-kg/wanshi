import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  getRunConfig,
  getRunOutput,
  launchCmd,
  repoCwd,
} from "@/server/run-registry"
import { getPath } from "@/lib/config-schema"
import { loadGraph } from "@/server/graph-loader"

export const EXPORT_FORMATS = [
  "json",
  "jsonl",
  "mcp-jsonl",
  "dot",
  "kblam",
  "lora",
  "graphiti",
] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export class NoGraphError extends Error {}

/**
 * Re-export a run's graph into another format by reusing wanshi's `--export-only`
 * CLI (same strategies as the pipeline; pure transforms). The source graph is
 * normalized first, so a json/jsonl/mcp original re-exports fine.
 */
export async function exportGraph(
  id: string,
  format: ExportFormat
): Promise<{ content: string; filename: string }> {
  const output = getRunOutput(id)
  if (!output || !existsSync(output)) {
    throw new NoGraphError("No graph file for this run")
  }

  // Normalize the source (handles json/jsonl/mcp) into a plain graph JSON.
  const graph = loadGraph(output)

  const dir = mkdtempSync(path.join(tmpdir(), "wanshi-export-"))
  try {
    const srcPath = path.join(dir, "graph.json")
    const outPath = path.join(dir, `export.${format}`)
    writeFileSync(srcPath, JSON.stringify(graph))

    // Carry the run's export.dot / grounding.minScore so dot/lora keep fidelity.
    const stored = getRunConfig(id)?.config ?? {}
    const exportCfg: Record<string, unknown> = { format }
    const dot = getPath(stored, "export.dot")
    if (dot) exportCfg.dot = dot
    const cfg: Record<string, unknown> = {
      input: srcPath,
      output: outPath,
      export: exportCfg,
    }
    const minScore = getPath(stored, "grounding.minScore")
    if (minScore != null) cfg.grounding = { minScore }
    const cfgPath = path.join(dir, "config.json")
    writeFileSync(cfgPath, JSON.stringify(cfg))

    await runCli(["--config", cfgPath, "--export-only"])

    if (!existsSync(outPath)) throw new Error("export produced no output")
    const content = readFileSync(outPath, "utf-8")
    const base = path.basename(output).replace(/\.[^.]+$/, "")
    return { content, filename: `${base}.${format}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...base] = launchCmd()
    const child = spawn(bin, [...base, ...args], {
      cwd: repoCwd(),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env },
    })
    let stderr = ""
    child.stderr?.on("data", (d) => {
      stderr += String(d)
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split("\n").pop() || `export exited ${code}`))
    })
  })
}
