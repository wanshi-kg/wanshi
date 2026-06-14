import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { KnowledgeGraph } from "../../types";
import { Logger } from "../../shared";

/**
 * One completed unit of work: a single (file, chunk) extraction result.
 * `model`/`promptVersion` are stored (in addition to being folded into `key`)
 * so load can report how many records match the current run's settings.
 */
export interface CheckpointRecord {
  key: string;
  filePath: string;
  /**
   * Path relative to the discovery root (`input`), posix-normalized — the path
   * identity actually folded into `key`. Stored for transparency; absent on
   * records written before resume became relocation-robust.
   */
  relPath?: string;
  chunkIndex: number;
  totalChunks: number;
  model?: string;
  promptVersion?: string;
  kg: KnowledgeGraph;
}

/** The current run's identity, used to flag config drift at load time. */
export interface CheckpointContext {
  model: string;
  promptVersion: string;
}

/**
 * Append-only sidecar that records per-chunk extraction results so a long run
 * interrupted mid-way (e.g. API credits exhausted) can resume without
 * re-billing already-processed chunks.
 *
 * The work-unit key folds in the chunk content + model + prompt version, so
 * editing a file, switching models, or changing the prompt invalidates only the
 * affected entries.
 */
export class CheckpointService {
  private readonly path: string;
  private readonly logger: Logger;
  private readonly context?: CheckpointContext;
  private records: Map<string, KnowledgeGraph> = new Map();
  private loaded = false;
  private dirEnsured = false;

  constructor(checkpointPath: string, logger: Logger, context?: CheckpointContext) {
    this.path = checkpointPath;
    this.logger = logger;
    this.context = context;
  }

  getPath(): string {
    return this.path;
  }

  /**
   * Work-unit key. `pathId` must be a *stable* path identity — the path relative
   * to the discovery root (`input`), posix-normalized — so relocating the input
   * tree or changing the `input` prefix doesn't invalidate the checkpoint. The
   * caller (`KnowledgeGraphBuilder.stablePathId`) owns that normalization.
   *
   * `extra` folds in any other input that changes extraction *semantics* but not
   * the chunk text — currently the grounding signature (mode/checker/threshold/
   * model), so toggling the grounding gate between `--resume` runs invalidates
   * affected chunks instead of silently reusing a differently-gated graph
   * (scoped slice of KG-07; Phase 6 extends this with glossary/retrieval/etc.).
   * Defaults to "" so existing callers are unaffected.
   */
  computeKey(
    pathId: string,
    chunkIndex: number,
    content: string,
    model: string,
    promptVersion: string,
    extra: string = ""
  ): string {
    const hash = crypto.createHash("sha1");
    hash.update(
      `${pathId} ${chunkIndex} ${model} ${promptVersion} ${extra} `
    );
    hash.update(content);
    return hash.digest("hex");
  }

  /**
   * Load any existing checkpoint into memory. Tolerant of a truncated final
   * line left behind by an interrupted append.
   */
  async load(): Promise<number> {
    if (this.loaded) return this.records.size;
    this.loaded = true;

    if (!fs.existsSync(this.path)) {
      this.logger.info(`No existing checkpoint at ${this.path}; starting fresh`);
      return 0;
    }

    const content = await fs.promises.readFile(this.path, "utf-8");
    const lines = content.split("\n");
    let loaded = 0;
    let skipped = 0;
    let matchingContext = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as CheckpointRecord;
        if (record.key && record.kg) {
          this.records.set(record.key, record.kg);
          loaded++;
          if (this.matchesContext(record)) matchingContext++;
        }
      } catch {
        skipped++; // truncated/corrupt line — drop it, it'll be regenerated
      }
    }

    this.logger.info(
      `Loaded ${loaded} checkpointed chunk(s) from ${this.path}` +
        (skipped ? ` (skipped ${skipped} corrupt line(s))` : "")
    );

    // Resume reuses a chunk only when file content AND model/prompt match. Make
    // config drift visible — it's the usual reason "resume" appears to do nothing.
    if (this.context && loaded > 0) {
      const { model, promptVersion } = this.context;
      if (matchingContext === 0) {
        this.logger.warn(
          `None of the ${loaded} checkpointed chunk(s) were created with the current ` +
            `model '${model}' / prompt '${promptVersion}', so they will NOT be reused — ` +
            `resume effectively starts fresh. The model, prompt version, or chunk size ` +
            `likely changed since the checkpoint was written. Delete ${this.path} to start clean.`
        );
      } else if (matchingContext < loaded) {
        this.logger.info(
          `${matchingContext}/${loaded} checkpointed chunk(s) match the current model/prompt ` +
            `and may be reused (the rest were written with different settings).`
        );
      } else {
        this.logger.info(
          `All ${loaded} checkpointed chunk(s) match the current model/prompt; chunks with ` +
            `unchanged content will be skipped.`
        );
      }
    }

    return loaded;
  }

  /**
   * True when a record could be reused under the current model + prompt version.
   * Legacy records (written before model/promptVersion were stored) are treated
   * as "unknown" rather than mismatched — the content-based `key` remains the
   * real gate for reuse.
   */
  private matchesContext(record: CheckpointRecord): boolean {
    if (!this.context) return true;
    if (record.model === undefined && record.promptVersion === undefined) {
      return true; // legacy record, can't tell — don't raise a false alarm
    }
    return (
      record.model === this.context.model &&
      record.promptVersion === this.context.promptVersion
    );
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  get(key: string): KnowledgeGraph | undefined {
    return this.records.get(key);
  }

  /**
   * Persist a completed work unit (the per-chunk KG must already carry its
   * entity metadata) and keep the in-memory index in sync.
   */
  async append(record: CheckpointRecord): Promise<void> {
    this.records.set(record.key, record.kg);
    // Ensure the parent dir exists: when --resume writes to a not-yet-created output
    // subdir, the per-chunk append would otherwise ENOENT and every chunk would be
    // lost (the final graph save creates the dir, but only at the very end).
    if (!this.dirEnsured) {
      await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    await fs.promises.appendFile(this.path, JSON.stringify(record) + "\n");
  }
}
