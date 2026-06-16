import * as fs from "fs";
import * as path from "path";
import { TraceEvent, TraceRecord, TRACE_VERSION } from "./events";
import { LineageRegistry } from "./lineage";

export interface TraceConfig {
  enabled: boolean;
  path?: string;
  runId: string;
}

/**
 * The debug trace sidecar writer — a module singleton (à la `shared/shutdown.ts`
 * and `vocabulary.ts`'s domain-gate) so every pipeline stage can `trace.emit(...)`
 * without re-plumbing the DI graph. `ContainerFactory` calls `configure` once.
 *
 * Append-only JSONL (`<output>.trace.jsonl`), mirroring `CheckpointService`:
 * parent-dir ensured on first write, best-effort, **never throws** — a trace I/O
 * failure must not take down (or alter) a run. Off by default ⇒ `emit` is an
 * early return and call sites guard rich payloads with `if (trace.enabled)`, so a
 * default run carries zero overhead and is byte-identical.
 */
export class TraceWriter {
  private _enabled = false;
  private outputPath?: string;
  private runId = "";
  private seq = 0;
  private dirEnsured = false;
  /** Run-scoped lineage index (mention IDs live here, never on the graph). */
  readonly lineage = new LineageRegistry();

  get enabled(): boolean {
    return this._enabled;
  }

  configure(config: TraceConfig): void {
    this._enabled = config.enabled && !!config.path;
    this.outputPath = config.path;
    this.runId = config.runId;
    this.seq = 0;
    this.dirEnsured = false;
    this.lineage.reset();
  }

  emit(event: TraceEvent): void {
    if (!this._enabled || !this.outputPath) return;
    const record: TraceRecord = {
      v: TRACE_VERSION,
      runId: this.runId,
      ts: new Date().toISOString(),
      seq: this.seq++,
      ...event,
    };
    try {
      if (!this.dirEnsured) {
        fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
        this.dirEnsured = true;
      }
      fs.appendFileSync(this.outputPath, JSON.stringify(record) + "\n");
    } catch {
      // Best-effort side channel — swallow (e.g. ENOSPC/EPIPE) so the run is unaffected.
    }
  }

  /** Test/reset hook — restore the disabled default + clear lineage. */
  reset(): void {
    this._enabled = false;
    this.outputPath = undefined;
    this.runId = "";
    this.seq = 0;
    this.dirEnsured = false;
    this.lineage.reset();
  }
}

/** The process-wide trace singleton. */
export const trace = new TraceWriter();
