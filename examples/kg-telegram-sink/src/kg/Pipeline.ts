import * as fs from "fs";
import { ContainerFactory, TYPES } from "kg-gen/src/core/di";
import { IDirectoryProcessor, ProcessingOptions } from "kg-gen/src/types";

export interface GraphCounts {
  entities: number;
  relations: number;
}

export interface RebuildResult {
  before: GraphCounts;
  after: GraphCounts;
  /** Per-rebuild deltas (can be negative if merge/dedup collapsed entities). */
  delta: GraphCounts;
}

/** Count entity/relation lines in an mcp-jsonl file (missing file → zeros). */
export function readGraphCounts(outputPath: string): GraphCounts {
  if (!fs.existsSync(outputPath)) return { entities: 0, relations: 0 };
  let entities = 0;
  let relations = 0;
  for (const line of fs.readFileSync(outputPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t.includes('"type":"entity"')) entities++;
    else if (t.includes('"type":"relation"')) relations++;
  }
  return { entities, relations };
}

/**
 * Owns the kg-gen container (built once) and the debounced, single-flight rebuild
 * loop. Each rebuild runs the full pipeline over the inbox; `resume` makes it skip
 * already-extracted chunks, so re-processing the whole inbox per new item is cheap.
 */
export class Pipeline {
  private processor!: IDirectoryProcessor;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private rerunQueued = false;
  private waiters = new Set<number>(); // chatIds awaiting the next completion

  constructor(
    private readonly options: ProcessingOptions,
    private readonly debounceMs: number,
    private readonly onComplete: (result: RebuildResult, chatIds: number[]) => void,
    private readonly onError: (err: unknown, chatIds: number[]) => void,
    private readonly log: (msg: string) => void
  ) {}

  async init(): Promise<void> {
    const container = ContainerFactory.createContainer({ processingOptions: this.options });
    this.processor = await container.resolve<IDirectoryProcessor>(TYPES.DirectoryProcessor);
  }

  /** Ask for a rebuild; coalesces bursts within the debounce window. */
  requestRebuild(chatId?: number): void {
    if (chatId !== undefined) this.waiters.add(chatId);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  private async run(): Promise<void> {
    if (this.running) {
      this.rerunQueued = true; // a rebuild landed mid-flight; do one more after.
      return;
    }
    this.running = true;
    const chatIds = [...this.waiters];
    this.waiters.clear();

    const before = readGraphCounts(this.options.output);
    try {
      this.log("rebuild: processing inbox…");
      await this.processor.processDirectory(this.options);
      const after = readGraphCounts(this.options.output);
      const result: RebuildResult = {
        before,
        after,
        delta: {
          entities: after.entities - before.entities,
          relations: after.relations - before.relations,
        },
      };
      this.log(`rebuild done: ${after.entities} entities / ${after.relations} relations`);
      this.onComplete(result, chatIds);
    } catch (err) {
      this.log(`rebuild failed: ${err}`);
      this.onError(err, chatIds);
    } finally {
      this.running = false;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        this.requestRebuild();
      }
    }
  }
}
