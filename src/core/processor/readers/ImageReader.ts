import * as fs from "fs";
import * as path from "path";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { readExif, readC2pa } from "./image/imageMetadata";
import { Detection, IObjectDetector } from "../../../types/IObjectDetector";

/** Deterministic image-metadata toggles (off by default → byte-identical run). */
export interface ImageReaderOptions {
  /** Extract EXIF (GPS/time/camera) into `metadata.exif` for the graph fragment. */
  exif: boolean;
  /** Read C2PA content credentials (shell c2patool) into `metadata.c2pa`. */
  c2pa: { enabled: boolean; command: string };
}

/**
 * Reader for image files. Returns a placeholder text + the image buffer for the
 * multimodal (VLM) path, and — when enabled — stashes deterministic metadata
 * (`metadata.exif`/`.c2pa`) + an opt-in CV object-detection signal
 * (`metadata.cvDetection`) that `buildImageMetaGraph` turns into graph facts
 * AUGMENTING (not replacing) the VLM read. The detection summary is also appended
 * to the chunk content so the vision model sees it as context. All enrichment is
 * additive and independent of the VLM mode; off by default ⇒ byte-identical run.
 */
export class ImageReader extends FileReader {
  constructor(
    chunker: TextChunker,
    logger: Logger,
    private readonly opts: ImageReaderOptions = { exif: false, c2pa: { enabled: false, command: "c2patool" } },
    private readonly detector?: IObjectDetector
  ) {
    super(
      [
        ".jpg",
        ".jpeg",
        ".jpe",
        ".jif",
        ".jfif",
        ".jfi",
        ".png",
        ".gif",
        ".webp",
        ".tiff",
        ".tif",
        ".bmp",
        ".dib",
        ".svg",
        ".svgz",
        ".ico",
        ".cur",
        ".pbm",
        ".pgm",
        ".ppm",
        ".pnm",
        ".heif",
        ".heic",
        ".avif",
        ".apng",
      ],
      chunker,
      logger
    );
  }

  getName(): string {
    return "ImageReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      this.logger.debug(`Reading image file: ${filePath}`);
      const imageBuffer = await fs.promises.readFile(filePath);
      const fileName = path.basename(filePath);
      const stats = await fs.promises.stat(filePath);

      const metadata: Record<string, any> = {
        type: "image",
        fileName,
        size: stats.size,
        extension: path.extname(filePath).toLowerCase(),
      };
      // Deterministic enrichment (opt-in): stash structured metadata for the
      // graph fragment. Best-effort — a failed/empty read leaves metadata absent.
      if (this.opts.exif) {
        const exif = await readExif(filePath, this.logger);
        if (exif) metadata.exif = exif;
      }
      if (this.opts.c2pa.enabled) {
        metadata.c2pa = await readC2pa(filePath, this.opts.c2pa.command, this.logger);
      }

      // CV pre-pass (opt-in): object detections feed BOTH the graph fragment
      // (metadata.cvDetection) AND the VLM as context (appended to the chunk
      // content, which reaches the vision model verbatim). Detector never throws.
      let content = `[Image file: ${fileName}]`;
      if (this.detector) {
        const objects = await this.detector.detect(filePath);
        if (objects.length) {
          metadata.cvDetection = { objects };
          content += `\nCV pre-pass detected: ${this.summarize(objects)}`;
        }
      }

      return {
        chunks: [
          {
            content,
            index: 1,
            totalChunks: 1,
            startOffset: 0,
            endOffset: imageBuffer.length,
            images: [{ path: fileName, buffer: imageBuffer }],
          },
        ],
        metadata,
      };
    } catch (error) {
      this.logger.error(`Failed to read image file ${filePath}: ${error}`);
      throw new Error(`Failed to read image file: ${error}`);
    }
  }

  /** "person ×3, motorbike ×2" — counts per label, most frequent first. */
  private summarize(objects: Detection[]): string {
    const counts = new Map<string, number>();
    for (const o of objects) counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
      .join(", ");
  }
}
