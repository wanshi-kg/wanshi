import { Logger } from "../../shared";
import { Detection, IObjectDetector } from "../../types/IObjectDetector";

/** Object-detection knobs (from `readers.cv.detection`). */
export interface CvDetectionOptions {
  /** `closed` = fixed COCO classes (DETR/YOLOS); `zero-shot` = open-vocab (OWL-ViT) via `labels`. */
  mode: "closed" | "zero-shot";
  /** HF model id; empty ⇒ per-mode default. */
  model: string;
  /** Min detection score to keep (0..1). */
  threshold: number;
  /** Candidate labels for zero-shot detection (ignored for closed). */
  labels: string[];
  /** Cap detected objects per image. */
  maxObjects: number;
  /** transformers.js model cache dir (`env.cacheDir`). */
  cacheDir?: string;
  /** Allow downloading the model from the HF Hub (`env.allowRemoteModels`). */
  allowRemote: boolean;
}

/**
 * A transformers.js detection pipeline, narrowed to the call we make. Injectable
 * so unit tests run fully offline (mirrors `TesseractDeps`); the real pipeline is
 * lazy-imported once and reused.
 */
export type DetectionPipeline = (
  image: string,
  arg2?: any,
  arg3?: any
) => Promise<Array<{ label: string; score: number; box: Detection["box"] }>>;

const DEFAULT_CLOSED_MODEL = "Xenova/detr-resnet-50";
const DEFAULT_ZEROSHOT_MODEL = "Xenova/owlvit-base-patch32";

/**
 * Opt-in CV object detector backed by `@huggingface/transformers` (already a dep;
 * bundles onnxruntime-node + sharp — zero new deps). Loads the pipeline **once**
 * (a per-image `pipeline()` would reload the model), then runs it per image. Two
 * config-selectable modes: `closed` (`object-detection`, COCO-80) and `zero-shot`
 * (`zero-shot-object-detection`, open-vocab via `labels`). The heavy dep is
 * lazy-imported so a run with detection off pays nothing.
 *
 * Signal-not-verdict (Phase 2): detections are confidence-tagged (the detector's
 * own score) and feed the VLM context + a `cv-detection` graph fragment. Any
 * failure (model download offline, bad image, empty zero-shot labels) → `[]` with
 * a one-time warn — no signal, never a throw (the C2PA `unavailable` discipline).
 */
export class ObjectDetectionService implements IObjectDetector {
  private pipelinePromise?: Promise<DetectionPipeline>;
  private warned = false;

  constructor(
    private readonly opts: CvDetectionOptions,
    private readonly logger: Logger,
    private readonly injectedPipeline?: DetectionPipeline
  ) {}

  async detect(filePath: string): Promise<Detection[]> {
    if (this.opts.mode === "zero-shot" && this.opts.labels.length === 0) {
      this.warnOnce("Object detection mode=zero-shot but readers.cv.detection.labels is empty; skipping");
      return [];
    }
    try {
      const pipe = await this.loadPipeline();
      const raw =
        this.opts.mode === "zero-shot"
          ? await pipe(filePath, this.opts.labels, { threshold: this.opts.threshold })
          : await pipe(filePath, { threshold: this.opts.threshold });
      return (Array.isArray(raw) ? raw : [])
        .filter((d) => d && typeof d.label === "string" && typeof d.score === "number" && d.score >= this.opts.threshold)
        .map((d) => ({ label: d.label, score: d.score, box: d.box }))
        .sort((a, b) => b.score - a.score)
        .slice(0, this.opts.maxObjects);
    } catch (e: any) {
      this.warnOnce(`Object detection unavailable (${e?.message ?? e}); no CV signal emitted`);
      return [];
    }
  }

  /** Lazy-load + cache the pipeline. A rejected load stays cached (detect() → []). */
  private loadPipeline(): Promise<DetectionPipeline> {
    if (this.injectedPipeline) return Promise.resolve(this.injectedPipeline);
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const tf: any = await import("@huggingface/transformers");
        if (this.opts.cacheDir) tf.env.cacheDir = this.opts.cacheDir;
        if (!this.opts.allowRemote) tf.env.allowRemoteModels = false;
        const task = this.opts.mode === "zero-shot" ? "zero-shot-object-detection" : "object-detection";
        const model = this.opts.model || (this.opts.mode === "zero-shot" ? DEFAULT_ZEROSHOT_MODEL : DEFAULT_CLOSED_MODEL);
        this.logger.info(`Loading object-detection pipeline (${task}, ${model})`);
        return (await tf.pipeline(task, model)) as DetectionPipeline;
      })();
    }
    return this.pipelinePromise;
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(message);
  }
}
