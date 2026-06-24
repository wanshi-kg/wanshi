import { FileReader, FileReadResult, ChunkResult } from "./FileReader";
import path from "path";
import fs from "fs/promises";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

type FetchFn = (url: string, init?: any) => Promise<Response>;

/** Mistral OCR engine knobs (from `readers.mistral`). */
export interface MistralOptions {
  apiKey?: string;
  host: string;
  model: string;
  timeoutMs: number;
}

/** One OCR'd page as cached/emitted (the slice of the API response we keep). */
interface OcrPage {
  index: number;
  markdown: string;
}

/**
 * PDF reader backed by the Mistral OCR HTTP API. Native fetch (no SDK, no Python),
 * mirroring `GrobidClient`'s injected-`fetchFn` shape so it is unit-testable.
 * Claims `.pdf` only.
 *
 * Flow (per kcd's pipeline): upload file (purpose=ocr) → signed URL → `POST /v1/ocr`
 * → `pages[].markdown` → delete the upload. Each page becomes a chunk (like
 * PdfReader's per-page chunks). OCR costs money, so results cache to a
 * `<pdf>.mistral.json` sidecar reused when newer than the source — re-runs never
 * re-spend. Missing key / HTTP error **degrades to the injected pdf2json fallback**.
 */
export class MistralOcrReader extends FileReader {
  constructor(
    private readonly opts: MistralOptions,
    private readonly fallback: FileReader,
    chunker: TextChunker,
    logger: Logger,
    private readonly fetchFn: FetchFn = (globalThis as any).fetch
  ) {
    super([".pdf"], chunker, logger);
  }

  getName(): string {
    return "MistralOcrReader";
  }

  adapterId(): string {
    return "pdf:mistral";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    if (!this.opts.apiKey) {
      this.logger.warn(
        `Mistral OCR engine selected but no API key (set readers.mistral.apiKey or $MISTRAL_API_KEY); falling back to pdf2json for ${filePath}`
      );
      return this.readWithFallback(filePath);
    }

    try {
      const startTime = Date.now();
      const { pages, cached } = await this.ocr(filePath);
      const usable = pages.filter((p) => p.markdown.trim());
      if (usable.length === 0) throw new Error("Mistral OCR returned no page text");

      // WS-54: empty pages are silently dropped; surface that as a warning + a
      // `pagesDropped` signal so a partial OCR isn't mistaken for a complete read.
      const pagesDropped = pages.length - usable.length;
      if (pagesDropped > 0) {
        this.logger.warn(
          `Mistral OCR dropped ${pagesDropped}/${pages.length} empty page(s) for ${filePath}`
        );
      }

      const chunks: ChunkResult[] = [];
      let offset = 0;
      usable.forEach((p, i) => {
        const content = p.markdown;
        chunks.push({
          content, index: i + 1, totalChunks: usable.length,
          startOffset: offset, endOffset: offset + content.length,
          provenance: { locator: `p.${p.index + 1}` }, // 1-based page number (ECS locator)
        });
        offset += content.length;
      });

      const stats = await fs.stat(filePath);
      return {
        chunks,
        metadata: {
          type: "pdf",
          fileName: filePath,
          fileSize: stats.size,
          pdfEngine: "mistral",
          mistralModel: this.opts.model,
          mistralCached: cached,
          pageCount: usable.length,
          totalPages: pages.length,
          pagesDropped,
          processingTimeMs: Date.now() - startTime,
          status: "success",
        },
      };
    } catch (error: any) {
      this.logger.warn(
        `Mistral OCR engine failed for ${filePath} (${error.message}); falling back to pdf2json`
      );
      return this.readWithFallback(filePath);
    }
  }

  /**
   * Delegate to the pdf2json fallback and stamp ITS adapterId on the returned
   * chunks so per-engine provenance reflects what actually produced the text
   * (pdf2json), not this engine (WS-11).
   */
  private async readWithFallback(filePath: string): Promise<FileReadResult> {
    const fallbackResult = await this.fallback.read(filePath);
    const fallbackAdapter = this.fallback.adapterId();
    return {
      ...fallbackResult,
      chunks: fallbackResult.chunks.map((c) => ({
        ...c,
        provenance: { ...c.provenance, sourceAdapter: fallbackAdapter },
      })),
    };
  }

  /** OCR the PDF (or reuse the sidecar). Throws on any API failure. */
  private async ocr(filePath: string): Promise<{ pages: OcrPage[]; cached: boolean }> {
    const sidecar = `${filePath}.mistral.json`;
    if (await this.sidecarIsFresh(sidecar, filePath)) {
      this.logger.debug(`Reusing Mistral OCR sidecar: ${sidecar}`);
      return { pages: JSON.parse(await fs.readFile(sidecar, "utf-8")) as OcrPage[], cached: true };
    }

    const buf = await fs.readFile(filePath);
    const fileId = await this.uploadFile(buf, path.basename(filePath));
    try {
      const url = await this.signedUrl(fileId);
      const pages = await this.processOcr(url);
      await fs.writeFile(sidecar, JSON.stringify(pages), "utf-8");
      return { pages, cached: false };
    } finally {
      // Best-effort cleanup of the uploaded file (don't fail the read on this).
      await this.deleteFile(fileId).catch((e) =>
        this.logger.debug(`Mistral file delete failed for ${fileId}: ${e}`)
      );
    }
  }

  private async uploadFile(buf: Buffer, fileName: string): Promise<string> {
    const form = new FormData();
    form.append("purpose", "ocr");
    form.append("file", new Blob([buf]), fileName || "doc.pdf");
    const res = await this.fetchFn(`${this.opts.host}/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: this.timeout(),
    });
    if (!res.ok) throw new Error(`Mistral files.upload ${res.status}`);
    const id = (await res.json())?.id;
    if (!id) throw new Error("Mistral files.upload returned no id");
    return id;
  }

  private async signedUrl(fileId: string): Promise<string> {
    const res = await this.fetchFn(`${this.opts.host}/v1/files/${fileId}/url?expiry=24`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, Accept: "application/json" },
      signal: this.timeout(),
    });
    if (!res.ok) throw new Error(`Mistral files.get_signed_url ${res.status}`);
    const url = (await res.json())?.url;
    if (!url) throw new Error("Mistral signed-url response had no url");
    return url;
  }

  private async processOcr(documentUrl: string): Promise<OcrPage[]> {
    const res = await this.fetchFn(`${this.opts.host}/v1/ocr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        document: { type: "document_url", document_url: documentUrl },
        include_image_base64: false,
      }),
      signal: this.timeout(),
    });
    if (!res.ok) throw new Error(`Mistral ocr.process ${res.status}`);
    const json: any = await res.json();
    const pages: any[] = Array.isArray(json?.pages) ? json.pages : [];
    return pages.map((p, i) => ({
      index: typeof p.index === "number" ? p.index : i,
      markdown: typeof p.markdown === "string" ? p.markdown : "",
    }));
  }

  private async deleteFile(fileId: string): Promise<void> {
    const res = await this.fetchFn(`${this.opts.host}/v1/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      signal: this.timeout(),
    });
    if (!res.ok) throw new Error(`Mistral files.delete ${res.status}`);
  }

  private timeout(): AbortSignal | undefined {
    return typeof (AbortSignal as any).timeout === "function"
      ? (AbortSignal as any).timeout(this.opts.timeoutMs)
      : undefined;
  }

  private async sidecarIsFresh(sidecar: string, filePath: string): Promise<boolean> {
    try {
      const [s, a] = await Promise.all([fs.stat(sidecar), fs.stat(filePath)]);
      return s.mtimeMs >= a.mtimeMs;
    } catch {
      return false;
    }
  }
}
