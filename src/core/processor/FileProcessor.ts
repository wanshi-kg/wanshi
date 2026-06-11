import * as path from "path";
import {
  ClassificationResult,
  IFileProcessor,
  ProcessedChunk,
  ProcessedFile,
  ProcessedImage,
} from "../../types";
import { FileReaderFactory, FileReadResult } from "./readers";
import { Logger } from "../../shared";
import { IContentClassifier } from "./classifier/IContentTypeClassifier";

/**
 * Main file processor that coordinates reading and chunking
 */
export class FileProcessor implements IFileProcessor {
  private readonly readerFactory: FileReaderFactory;
  private readonly logger: Logger;
  private readonly attachImages: boolean;
  private readonly classifier?: IContentClassifier;

  constructor(
    readerFactory: FileReaderFactory,
    classifier: IContentClassifier | undefined,
    attachImages: boolean,
    logger: Logger
  ) {
    this.readerFactory = readerFactory;
    this.logger = logger;
    this.attachImages = attachImages;
    this.classifier = classifier;
  }

  /**
   * Process a single file - read and optionally chunk it
   */
  async processFile(
    filePath: string,
    cachedClasses?: ClassificationResult[]
  ): Promise<ProcessedFile> {
    this.logger.info(`Processing file: ${filePath}`);

    // Get appropriate reader
    const reader = this.readerFactory.getReader(filePath);
    if (!reader) {
      this.logger.warn(`No reader available for file: ${filePath}`);
      return {
        chunks: [],
        path: filePath,
        metadata: {
          error: "No reader available",
          fileType: path.extname(filePath),
        },
      };
    }

    try {
      // Read the file
      const readResult = await reader.read(filePath);

      // Return results
      return {
        path: filePath,
        content: this.reconstructContent(readResult.chunks),
        chunks: readResult.chunks.map((chunk) => {
          return {
            content: chunk.content,
            index: chunk.index,
            totalChunks: chunk.totalChunks,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            ...(chunk.provenance && { provenance: chunk.provenance }),
            ...(this.attachImages && {
              images: chunk.images?.map((image) => {
                return {
                  path: image.path,
                  caption: image.alt,
                  base64: image.buffer?.toString("base64"),
                } as ProcessedImage;
              }),
            }),
          } as ProcessedChunk;
        }),
        metadata: {
          ...readResult.metadata,
          // Reuse the corpus pre-pass's cached classification when provided,
          // otherwise classify now (the classifier is the expensive bit).
          classes: cachedClasses ?? (await this.classifyContent(filePath, readResult)),
          chunked: false,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to process file ${filePath}: ${error}`);
      throw new Error(`Failed to process file ${filePath}: ${error}`);
    }
  }

  /**
   * Reconstruct the full source text from chunks using their offsets, dropping
   * any overlap added by the chunker. Falls back to plain concatenation when
   * offsets are absent/unreliable. Used for outline generation and grounding.
   */
  private reconstructContent(
    chunks: { content: string; startOffset?: number; endOffset?: number }[]
  ): string {
    if (chunks.length === 0) return "";
    if (chunks.length === 1) return chunks[0].content;

    const sorted = [...chunks].sort(
      (a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0)
    );
    let result = "";
    let cursor = 0;
    for (const c of sorted) {
      const start = c.startOffset ?? cursor;
      const end = c.endOffset ?? start + c.content.length;
      if (start >= cursor) {
        result += c.content;
      } else {
        const overlap = cursor - start;
        result += overlap < c.content.length ? c.content.slice(overlap) : "";
      }
      cursor = Math.max(cursor, end);
    }
    return result;
  }

  private async classifyContent(filePath: string, readResult: FileReadResult) {
    let classes: ClassificationResult[] | undefined = undefined;
    try {
      if (this.classifier) {
        const results = await Promise.all(
          readResult.chunks.map((chunk) =>
            this.classifier?.classify(chunk.content, filePath)
          )
        );
        const mergeClassificationResults = (
          a: ClassificationResult[],
          b: ClassificationResult[]
        ): ClassificationResult[] => {
          const uniqueClasses = Array.from(
            new Set([...a.map((c) => c.class), ...b.map((c) => c.class)])
          );
          const merged = uniqueClasses.map((cls) => {
            const resultsByClass = [
              ...a.filter((x) => x.class === cls),
              ...b.filter((x) => x.class === cls),
            ];
            const confidenceSum = resultsByClass.reduce(
              (acc, curr) => acc + curr.confidence,
              0
            );
            return {
              class: cls,
              confidence: confidenceSum / resultsByClass.length,
            } as ClassificationResult;
          });
          return merged;
        };

        classes = results
          .reduce<ClassificationResult[]>(
            (acc, curr) => mergeClassificationResults(acc, curr || []),
            []
          )
          .sort((a, b) => b.confidence - a.confidence);

        // classes = await this.classifier?.classify(readResult.chunks[0].content, filePath);
      }
    } catch (error) {
      this.logger.error("Unable to classify file content.", error);
    }

    return classes;
  }

  /**
   * Check if a file can be processed
   */
  canProcess(filePath: string): boolean {
    return this.readerFactory.canRead(filePath);
  }
}
