import * as fs from "fs";
import * as path from "path";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { readExif } from "./image/imageMetadata";

/** Deterministic image-metadata toggles (off by default → byte-identical run). */
export interface ImageReaderOptions {
  /** Extract EXIF (GPS/time/camera) into `metadata.exif` for the graph fragment. */
  exif: boolean;
}

/**
 * Reader for image files. Returns a placeholder text + the image buffer for the
 * multimodal (VLM) path, and — when enabled — stashes deterministic `metadata.exif`
 * that `buildImageMetaGraph` turns into graph facts AUGMENTING (not replacing) the
 * VLM read. Metadata extraction is additive and independent of the VLM mode.
 */
export class ImageReader extends FileReader {
  constructor(chunker: TextChunker, logger: Logger, private readonly opts: ImageReaderOptions = { exif: false }) {
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

      return {
        chunks: [
          {
            content: `[Image file: ${fileName}]`,
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
}
