import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TesseractPdfReader, TesseractDeps } from "./TesseractPdfReader";
import { FileReader } from "./FileReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("TesseractPdfReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgtess-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const chunker = () => new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, stubLogger());
  const writePdf = (name = "doc.pdf") => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, "%PDF-1.4 dummy bytes (pdfToPng is mocked)");
    return p;
  };
  // A FileReader-shaped fallback that returns a recognizable sentinel chunk.
  const stubFallback = () =>
    ({
      read: jest.fn().mockResolvedValue({
        chunks: [{ content: "PDF2JSON-FALLBACK", index: 1, totalChunks: 1, startOffset: 0, endOffset: 17 }],
      }),
      adapterId: () => "pdf:pdf2json",
    }) as unknown as FileReader & { read: jest.Mock };

  // Injected rasterize+OCR doubles: N fake pages, OCR text = "OCR <n>".
  const okDeps = (pages = 2): { deps: Partial<TesseractDeps>; recognize: jest.Mock } => {
    let n = 0;
    const recognize = jest.fn(async () => ({ data: { text: `OCR ${++n}` } }));
    return {
      recognize,
      deps: {
        pdfToPng: async () =>
          Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, content: Buffer.from(`png${i + 1}`) })),
        createWorker: async () => ({ setParameters: async () => ({}), recognize, terminate: async () => ({}) }),
      },
    };
  };

  it("OCRs each page into its own chunk with a p.<n> locator", async () => {
    const { deps } = okDeps(2);
    const reader = new TesseractPdfReader({ lang: "eng", scale: 2 }, stubFallback(), chunker(), stubLogger(), deps);
    const res = await reader.read(writePdf());
    expect(res.chunks).toHaveLength(2);
    expect(res.chunks[0].content).toBe("OCR 1");
    expect(res.chunks[0].provenance?.locator).toBe("p.1");
    expect(res.chunks[1].provenance?.locator).toBe("p.2");
    expect(res.metadata?.pdfEngine).toBe("tesseract");
    expect(res.metadata?.tesseractCached).toBe(false);
  });

  it("reuses the <pdf>.tesseract.json sidecar on a second read (no re-OCR)", async () => {
    const { deps, recognize } = okDeps(1);
    const p = writePdf();
    const r1 = new TesseractPdfReader({ lang: "eng", scale: 2 }, stubFallback(), chunker(), stubLogger(), deps);
    await r1.read(p);
    expect(fs.existsSync(`${p}.tesseract.json`)).toBe(true);
    expect(recognize).toHaveBeenCalledTimes(1);

    const r2 = new TesseractPdfReader({ lang: "eng", scale: 2 }, stubFallback(), chunker(), stubLogger(), deps);
    const res2 = await r2.read(p);
    expect(res2.metadata?.tesseractCached).toBe(true);
    expect(recognize).toHaveBeenCalledTimes(1); // not called again — served from sidecar
  });

  it("degrades to the pdf2json fallback when rasterization throws", async () => {
    const fallback = stubFallback();
    const deps: Partial<TesseractDeps> = {
      pdfToPng: async () => {
        throw new Error("Invalid PDF structure");
      },
    };
    const reader = new TesseractPdfReader({ lang: "eng", scale: 2 }, fallback, chunker(), stubLogger(), deps);
    const p = writePdf();
    const res = await reader.read(p);
    expect(fallback.read).toHaveBeenCalledWith(p);
    expect(res.chunks[0].content).toBe("PDF2JSON-FALLBACK");
    // Provenance must reflect what produced the text (pdf2json), not "pdf:tesseract" (WS-11).
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("pdf:pdf2json");
  });

  it("degrades when OCR yields no text", async () => {
    const fallback = stubFallback();
    const deps: Partial<TesseractDeps> = {
      pdfToPng: async () => [{ pageNumber: 1, content: Buffer.from("png") }],
      createWorker: async () => ({
        setParameters: async () => ({}),
        recognize: async () => ({ data: { text: "   " } }),
        terminate: async () => ({}),
      }),
    };
    const reader = new TesseractPdfReader({ lang: "eng", scale: 2 }, fallback, chunker(), stubLogger(), deps);
    const res = await reader.read(writePdf());
    expect(fallback.read).toHaveBeenCalled();
    expect(res.chunks[0].content).toBe("PDF2JSON-FALLBACK");
  });

  it("claims .pdf, defers other extensions, and tags adapterId", () => {
    const reader = new TesseractPdfReader({ lang: "eng", scale: 2 }, stubFallback(), chunker(), stubLogger());
    expect(reader.canRead("/x/a.pdf")).toBe(true);
    expect(reader.canRead("/x/a.md")).toBe(false);
    expect(reader.adapterId()).toBe("pdf:tesseract");
  });
});
