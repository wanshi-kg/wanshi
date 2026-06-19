import * as fs from "fs";
import { ChunkResult, FileReader, FileReadResult, ImageResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { ImageMetadata, ImageBufferResolver } from "./MarkdownReader";

/** YAML-only `readers.jupyter` knobs (defaults live in `src/config/schema.ts`). */
export interface JupyterReaderOptions {
  /** Append text outputs (stream / execute_result / display_data text/plain). */
  includeOutputs: boolean;
  /** Attach base64 image outputs as chunk images (for the vision path). */
  includeImages: boolean;
}

/**
 * Reads Jupyter notebooks (`.ipynb`) **cell-type-aware**: markdown cells become
 * narrative, code cells fenced ```` ``` ```` blocks, optionally followed by their
 * outputs — far better than feeding the raw notebook JSON to a generic reader.
 * `sourceAdapter:"jupyter"` is stamped centrally from `adapterId()`.
 *
 * Outputs and image outputs are opt-in (`readers.jupyter.includeOutputs` /
 * `includeImages`, default off) since they often carry noise (tracebacks, repr
 * dumps, base64 blobs). Image outputs reuse the MarkdownReader image mechanism
 * (`![…](idx)` marker → `ChunkResult.images` via `ImageBufferResolver`).
 *
 * v1 deferred: cell-level provenance/locator, notebook attachments, error tracebacks.
 */
export class JupyterReader extends FileReader {
  constructor(chunker: TextChunker, logger: Logger, private readonly opts: JupyterReaderOptions) {
    super([".ipynb"], chunker, logger);
  }

  getName(): string {
    return "JupyterReader";
  }

  adapterId(): string {
    return "jupyter";
  }

  async read(filePath: string): Promise<FileReadResult> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    try {
      const nb = JSON.parse(raw);
      const cells: any[] = Array.isArray(nb?.cells) ? nb.cells : [];
      const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || "python";
      const images: ImageMetadata[] = [];
      const blocks: string[] = [];

      for (const cell of cells) {
        const src = this.srcToString(cell?.source);
        if (cell?.cell_type === "markdown") {
          blocks.push(src);
        } else if (cell?.cell_type === "code") {
          let block = "```" + lang + "\n" + src + "\n```";
          if (this.opts.includeOutputs || this.opts.includeImages) block += this.renderOutputs(cell?.outputs, images);
          blocks.push(block);
        } else if (cell?.cell_type === "raw") {
          blocks.push(src);
        }
      }

      const doc = blocks.filter((b) => b.trim()).join("\n\n");
      if (!doc.trim()) return this.plainFallback(raw);

      const parts = await this.chunker.chunk(doc);
      const chunks =
        this.opts.includeImages && images.length
          ? await this.attachImages(parts, images)
          : parts.map((p) => ({ ...p }));
      return { chunks, metadata: { type: "jupyter", cells: cells.length } };
    } catch (e) {
      this.logger.warn(`JupyterReader could not parse ${filePath}; falling back to plain chunking: ${e}`);
      return this.plainFallback(raw);
    }
  }

  /** nbformat `source`/`text` is a string or an array of line-strings. */
  private srcToString(src: any): string {
    return Array.isArray(src) ? src.join("") : typeof src === "string" ? src : "";
  }

  private renderOutputs(outputs: any, images: ImageMetadata[]): string {
    if (!Array.isArray(outputs)) return "";
    const lines: string[] = [];
    for (const o of outputs) {
      if (o?.output_type === "stream") {
        if (this.opts.includeOutputs) lines.push(this.srcToString(o.text));
      } else if (o?.output_type === "execute_result" || o?.output_type === "display_data") {
        const data = o?.data ?? {};
        if (this.opts.includeOutputs && data["text/plain"]) lines.push(this.srcToString(data["text/plain"]));
        if (this.opts.includeImages) {
          const img = data["image/png"] ?? data["image/jpeg"];
          if (typeof img === "string") {
            images.push({ base64: img.replace(/\s+/g, ""), alt: "cell output" });
            lines.push(`![cell output](${images.length - 1})`);
          }
        }
      }
      // output_type === "error" (tracebacks) is intentionally skipped
    }
    return lines.length ? "\n\nOutput:\n" + lines.join("\n") : "";
  }

  /** Resolve `![…](idx)` markers per chunk → image buffers (the MarkdownReader path). */
  private async attachImages(parts: ChunkResult[], images: ImageMetadata[]): Promise<ChunkResult[]> {
    return Promise.all(
      parts.map(async (chunk) => {
        const refs = [...chunk.content.matchAll(/!\[.*?\]\((\d+)\)/g)].map((m) => parseInt(m[1], 10));
        const imgs: ImageResult[] = [];
        for (const ref of refs) {
          if (ref >= 0 && ref < images.length) {
            try {
              imgs.push({ buffer: await ImageBufferResolver.resolve(images[ref]), alt: images[ref].alt });
            } catch (e) {
              this.logger.warn(`JupyterReader could not resolve image ${ref}: ${e}`);
            }
          }
        }
        return {
          content: chunk.content,
          images: imgs,
          index: chunk.index,
          totalChunks: chunk.totalChunks,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
        };
      })
    );
  }

  private async plainFallback(raw: string): Promise<FileReadResult> {
    const parts = await this.chunker.chunk(raw);
    return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "jupyter-fallback" } };
  }
}
