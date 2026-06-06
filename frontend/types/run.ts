/**
 * A run's lifecycle state, mirroring the gol-eval job state machine (minus
 * "paused", which kg-gen doesn't support).
 */
export type RunState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Structured progress events emitted by the kg-gen CLI in `--progress-ndjson`
 * mode. Mirrors `src/types/IProgressEmitter.ts` in the kg-gen core — keep the
 * two in sync.
 */
export type ProgressEvent =
  | { type: "discovery"; totalFiles: number }
  | { type: "file_start"; index: number; total: number; path: string }
  | {
      type: "file_complete"
      index: number
      total: number
      path: string
      entities: number
      relations: number
    }
  | { type: "chunk_start"; path: string; chunk: number; totalChunks: number }
  | {
      type: "chunk_complete"
      path: string
      chunk: number
      totalChunks: number
      entities: number
      relations: number
      cached: boolean
    }
  | { type: "merge"; graphCount: number }
  | {
      type: "export"
      format: string
      entities: number
      relations: number
      output: string
    }
  | {
      type: "done"
      entities: number
      relations: number
      output: string
      interrupted: boolean
    }
  | { type: "error"; message: string }

/** A line on the kg-gen stdout NDJSON stream: either a progress event or a log. */
export type StreamLine =
  | { channel: "progress"; ts: number; event: ProgressEvent }
  | { channel: "log"; ts: number; level: string; message: string }

/** A single log line surfaced to the UI. */
export interface LogLine {
  ts: number
  level: string
  message: string
}

/**
 * A run enriched with its config — what the runs list (dashboard + Results)
 * shows. Live runs get this from the registry record's request; historical runs
 * from the persisted store.
 */
export interface RunListItem extends RunSummary {
  input?: string
  model?: string
  provider?: string
  exportFormat?: string
}

/**
 * A run as persisted on disk (`~/.kg-gen/runs/<id>.json`). Carries the FULL
 * config so a past run can be reconstructed for Resume/Restart.
 */
export interface StoredRun {
  summary: RunSummary
  config: import("@/lib/kg-options").RunRequest
  passthrough?: Record<string, unknown>
}

/** Server-side summary of a run (what the registry tracks / the UI polls). */
export interface RunSummary {
  id: string
  state: RunState
  /** Files completed so far. */
  filesDone: number
  /** Total files discovered (0 until discovery completes). */
  filesTotal: number
  /** Currently processing file path, if any. */
  currentFile?: string
  /** Current chunk within the current file. */
  chunk?: number
  chunkTotal?: number
  /** Running tallies across the run. */
  entities: number
  relations: number
  /** Output path written on completion. */
  output?: string
  /** Error message when state === "failed". */
  error?: string
  startedAt: number
  endedAt?: number
}
