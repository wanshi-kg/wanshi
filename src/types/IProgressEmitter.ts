/**
 * Structured progress events emitted during a processing run.
 *
 * These exist so a non-terminal consumer (e.g. a Next.js server that spawned the
 * CLI, or any programmatic embedder) can observe a run's progress as structured
 * data instead of parsing log text. Emission is opt-in: the default emitter is a
 * no-op, so behavior is unchanged unless `--progress-ndjson` is set.
 *
 * Events fire at the natural checkpoints that already exist in the pipeline —
 * file discovery, the per-file loop, and the per-chunk loop — carrying only data
 * already known at that call site.
 */
export type ProgressEvent =
  | { type: "discovery"; totalFiles: number }
  | { type: "file_start"; index: number; total: number; path: string }
  | {
      type: "file_complete";
      index: number;
      total: number;
      path: string;
      entities: number;
      relations: number;
    }
  | { type: "chunk_start"; path: string; chunk: number; totalChunks: number }
  | {
      type: "chunk_complete";
      path: string;
      chunk: number;
      totalChunks: number;
      entities: number;
      relations: number;
      /** True when the chunk was restored from the resume checkpoint (no LLM call). */
      cached: boolean;
    }
  | { type: "merge"; graphCount: number }
  | {
      type: "export";
      format: string;
      entities: number;
      relations: number;
      output: string;
    }
  | {
      type: "done";
      entities: number;
      relations: number;
      output: string;
      /** True when the run was cut short by a cooperative interrupt (partial graph). */
      interrupted: boolean;
    }
  | { type: "error"; message: string };

/**
 * Sink for {@link ProgressEvent}s. Implementations must be cheap and must never
 * throw — progress reporting is strictly side-channel and must not affect a run.
 */
export interface IProgressEmitter {
  emit(event: ProgressEvent): void;
}
