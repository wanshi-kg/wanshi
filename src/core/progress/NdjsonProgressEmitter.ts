import { IProgressEmitter, ProgressEvent } from "../../types";

/**
 * Emits each progress event as a single newline-delimited JSON object on a
 * writable stream (stdout by default). Lines are wrapped in an envelope with a
 * `channel` discriminator so the same stream can also carry log lines
 * (`channel: "log"`, written by the logger in NDJSON mode) — a consumer reading
 * the stream demuxes the two by `channel`.
 *
 *   {"channel":"progress","ts":1717600000000,"event":{"type":"file_start",...}}
 *
 * Writes are best-effort and never throw, so a broken pipe (consumer went away)
 * can't take down a run.
 */
export class NdjsonProgressEmitter implements IProgressEmitter {
  constructor(private readonly stream: NodeJS.WritableStream = process.stdout) {}

  emit(event: ProgressEvent): void {
    try {
      this.stream.write(
        JSON.stringify({ channel: "progress", ts: Date.now(), event }) + "\n"
      );
    } catch {
      // side-channel only — swallow write errors (e.g. EPIPE)
    }
  }
}
