import { FileReader, FileReadResult, ChunkResult } from "./FileReader";
import fs from "fs/promises";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

/** Tesseract OCR engine knobs (from `readers.tesseract`). */
export interface TesseractOptions {
  /** Tesseract language code(s), e.g. "eng", "eng+deu". */
  lang: string;
  /** OCR engine mode (tesseract.js `createWorker` 2nd arg); default LSTM when unset. */
  oem?: number;
  /** Page segmentation mode (`tessedit_pageseg_mode`); default when unset. */
  psm?: number;
  /** pdf→png render scale (higher = sharper OCR input, slower / more memory). */
  scale: number;
  /** Offline traineddata dir/URL (no trailing slash); omit to use the CDN + cache. */
  langPath?: string;
}

/** One OCR'd page as cached/emitted. */
interface OcrPage {
  index: number; // 1-based page number
  text: string;
}

/**
 * The heavy rasterize + OCR deps, injectable for tests (mirrors
 * `MistralOcrReader`'s injected `fetchFn`). Production defaults lazy-import the
 * real `pdf-to-png-converter` + `tesseract.js`.
 */
export interface TesseractDeps {
  pdfToPng: (pdf: string, props?: any) => Promise<Array<{ pageNumber: number; content?: Buffer }>>;
  createWorker: (lang?: any, oem?: any, opts?: any) => Promise<{
    setParameters: (p: any) => Promise<any>;
    recognize: (img: any) => Promise<{ data: { text: string } }>;
    terminate: () => Promise<any>;
  }>;
}

/**
 * PDF reader backed by Tesseract OCR — the **light-local** rung of the engine
 * ladder, for hardware with no GPU and no VLM. Pure-JS/WASM, zero system binaries:
 * `pdf-to-png-converter` (pdf.js, no native/OS deps) rasterizes each page to a PNG
 * buffer in memory, then `tesseract.js` (WASM) OCRs it. Claims `.pdf` only.
 *
 * OCR is slow, so per-page text caches to a `<pdf>.tesseract.json` sidecar reused
 * when newer than the source (re-runs never re-OCR). Any failure — render error,
 * missing language data, empty output — **degrades to the injected pdf2json
 * fallback** so a run never dies on one PDF and the default path stays portable.
 * Each page is its own chunk with an ECS `locator: "p.<n>"` (PdfReader/Mistral
 * pattern). The heavy deps are lazy-imported so a default (pdf2json) run never
 * pays for pdfjs/WASM at startup.
 *
 * NB: tesseract.js fetches the language traineddata (~10-15 MB/lang) from its CDN
 * on first use and caches it; point `langPath` at a local mirror for a fully
 * offline weak-hardware deployment.
 */
export class TesseractPdfReader extends FileReader {
  constructor(
    private readonly opts: TesseractOptions,
    private readonly fallback: FileReader,
    chunker: TextChunker,
    logger: Logger,
    private readonly injectedDeps?: Partial<TesseractDeps>
  ) {
    super([".pdf"], chunker, logger);
  }

  getName(): string {
    return "TesseractPdfReader";
  }

  adapterId(): string {
    return "pdf:tesseract";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);
    try {
      const startTime = Date.now();
      const { pages, cached } = await this.ocr(filePath);
      const usable = pages.filter((p) => p.text.trim());
      if (usable.length === 0) throw new Error("Tesseract produced no text");

      const chunks: ChunkResult[] = [];
      let offset = 0;
      usable.forEach((p) => {
        const content = p.text;
        chunks.push({
          content,
          index: p.index,
          totalChunks: usable.length,
          startOffset: offset,
          endOffset: offset + content.length,
          provenance: { locator: `p.${p.index}` }, // 1-based page number (ECS locator)
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
          pdfEngine: "tesseract",
          tesseractLang: this.opts.lang,
          tesseractCached: cached,
          pageCount: usable.length,
          processingTimeMs: Date.now() - startTime,
          status: "success",
        },
      };
    } catch (error: any) {
      this.logger.warn(
        `Tesseract OCR engine failed for ${filePath} (${error.message}); falling back to pdf2json`
      );
      // Stamp the fallback's adapterId so per-engine provenance reflects what
      // actually produced the text (pdf2json), not this engine (WS-11).
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
  }

  /** Rasterize + OCR every page (or reuse the sidecar). Throws on failure. */
  private async ocr(filePath: string): Promise<{ pages: OcrPage[]; cached: boolean }> {
    const sidecar = `${filePath}.tesseract.json`;
    if (await this.sidecarIsFresh(sidecar, filePath)) {
      this.logger.debug(`Reusing Tesseract sidecar: ${sidecar}`);
      return { pages: JSON.parse(await fs.readFile(sidecar, "utf-8")) as OcrPage[], cached: true };
    }

    const { pdfToPng, createWorker } = await this.loadDeps();

    const pngPages = await pdfToPng(filePath, {
      returnPageContent: true, // in-memory PNG buffers, no temp files on disk
      viewportScale: this.opts.scale,
    });

    const worker = await createWorker(this.opts.lang, this.opts.oem, {
      ...(this.opts.langPath ? { langPath: this.opts.langPath } : {}),
    });
    try {
      if (typeof this.opts.psm === "number") {
        await worker.setParameters({ tessedit_pageseg_mode: this.opts.psm });
      }
      const pages: OcrPage[] = [];
      for (const pg of pngPages) {
        if (!pg.content) continue;
        const { data } = await worker.recognize(pg.content);
        pages.push({ index: pg.pageNumber, text: data.text ?? "" });
      }
      await fs.writeFile(sidecar, JSON.stringify(pages), "utf-8");
      return { pages, cached: false };
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  }

  /** Lazy-load the heavy deps (or use the injected test doubles). */
  private async loadDeps(): Promise<TesseractDeps> {
    const pdfToPng =
      this.injectedDeps?.pdfToPng ?? ((await import("pdf-to-png-converter")).pdfToPng as any);
    const createWorker =
      this.injectedDeps?.createWorker ?? ((await import("tesseract.js")).createWorker as any);
    return { pdfToPng, createWorker };
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
