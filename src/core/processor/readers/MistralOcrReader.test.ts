import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MistralOcrReader, MistralOptions } from "./MistralOcrReader";
import { FileReader, FileReadResult } from "./FileReader";
import { TextChunker } from "../chunking/TextChunker";

const makeLogger = () =>
  ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() } as any);

const jsonRes = (body: any, ok = true, status = 200): any => ({ ok, status, json: async () => body });

/** Default happy-path Mistral API router: upload → signed url → ocr → delete. */
const happyFetch = () =>
  jest.fn(async (url: string, init?: any) => {
    if (url.endsWith("/v1/files") && init?.method === "POST") return jsonRes({ id: "file_123" });
    if (url.includes("/v1/files/file_123/url")) return jsonRes({ url: "https://signed.example/doc.pdf" });
    if (url.endsWith("/v1/ocr")) {
      return jsonRes({ pages: [
        { index: 0, markdown: "# Page one\n\npage one body" },
        { index: 1, markdown: "page two body" },
      ] });
    }
    if (url.endsWith("/v1/files/file_123") && init?.method === "DELETE") return jsonRes({ deleted: true });
    return jsonRes({}, false, 404);
  });

const fallbackReader = (): FileReader =>
  ({
    read: jest.fn(async (): Promise<FileReadResult> => ({
      chunks: [{ content: "PDF2JSON FALLBACK", index: 1, totalChunks: 1, startOffset: 0, endOffset: 17 }],
      metadata: { type: "pdf", pdfEngine: "pdf2json" },
    })),
    getName: () => "StubFallback",
    adapterId: () => "pdf:pdf2json",
    canRead: () => true,
  } as any);

describe("MistralOcrReader", () => {
  let tmp: string;
  let logger: any;
  let fallback: FileReader;
  const opts: MistralOptions = { apiKey: "sk-mistral", host: "https://api.mistral.ai", model: "mistral-ocr-latest", timeoutMs: 5000 };

  const reader = (fetchFn: any, o: Partial<MistralOptions> = {}) => {
    const chunker = new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, logger);
    return new MistralOcrReader({ ...opts, ...o }, fallback, chunker, logger, fetchFn);
  };

  const writePdf = () => {
    const p = path.join(tmp, "doc.pdf");
    fs.writeFileSync(p, Buffer.from("%PDF-1.4 fake"));
    return p;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    logger = makeLogger();
    fallback = fallbackReader();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgms-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("OCRs the PDF into one chunk per page", async () => {
    const fetchFn = happyFetch();
    const res = await reader(fetchFn).read(writePdf());

    expect(res.metadata?.pdfEngine).toBe("mistral");
    expect(res.metadata?.pageCount).toBe(2);
    expect(res.chunks).toHaveLength(2);
    expect(res.chunks[0].content).toContain("page one body");
    expect(res.chunks[1].content).toContain("page two body");
    expect(res.chunks[1].index).toBe(2);
    // uploaded file is cleaned up
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("/v1/files/file_123"),
      expect.objectContaining({ method: "DELETE" })
    );
    expect((fallback as any).read).not.toHaveBeenCalled();
  });

  it("warns and records pagesDropped when OCR returns empty pages (WS-54)", async () => {
    const fetchFn = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/v1/files") && init?.method === "POST") return jsonRes({ id: "file_123" });
      if (url.includes("/v1/files/file_123/url")) return jsonRes({ url: "https://signed.example/doc.pdf" });
      if (url.endsWith("/v1/ocr")) {
        return jsonRes({ pages: [
          { index: 0, markdown: "page one body" },
          { index: 1, markdown: "   " }, // blank page (e.g. an image-only page OCR couldn't read)
          { index: 2, markdown: "page three body" },
        ] });
      }
      if (url.endsWith("/v1/files/file_123") && init?.method === "DELETE") return jsonRes({ deleted: true });
      return jsonRes({}, false, 404);
    });
    const res = await reader(fetchFn).read(writePdf());

    expect(res.chunks).toHaveLength(2);
    expect(res.metadata?.pageCount).toBe(2);
    expect(res.metadata?.totalPages).toBe(3);
    expect(res.metadata?.pagesDropped).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("dropped 1/3 empty page"));
  });

  it("writes then reuses a fresh sidecar (no second API spend)", async () => {
    const pdf = writePdf();
    const f1 = happyFetch();
    await reader(f1).read(pdf);
    expect(f1).toHaveBeenCalled();

    const f2 = happyFetch();
    const res = await reader(f2).read(pdf);
    expect(f2).not.toHaveBeenCalled(); // served from <pdf>.mistral.json
    expect(res.metadata?.mistralCached).toBe(true);
    expect(res.chunks).toHaveLength(2);
  });

  it("falls back to pdf2json when no API key is set", async () => {
    const fetchFn = happyFetch();
    const res = await reader(fetchFn, { apiKey: undefined }).read(writePdf());
    expect(fetchFn).not.toHaveBeenCalled();
    expect((fallback as any).read).toHaveBeenCalled();
    expect(res.chunks[0].content).toBe("PDF2JSON FALLBACK");
  });

  it("falls back to pdf2json on an API error", async () => {
    const fetchFn = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/v1/files") && init?.method === "POST") return jsonRes({ id: "file_123" });
      if (url.includes("/url")) return jsonRes({ url: "https://signed.example/doc.pdf" });
      if (url.endsWith("/v1/ocr")) return jsonRes({ error: "boom" }, false, 500);
      return jsonRes({ deleted: true });
    });
    const res = await reader(fetchFn).read(writePdf());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to pdf2json"));
    expect((fallback as any).read).toHaveBeenCalled();
    expect(res.chunks[0].content).toBe("PDF2JSON FALLBACK");
  });

  it("stamps the fallback's adapterId on chunks when the fallback fires (WS-11)", async () => {
    const fetchFn = jest.fn(async (url: string, init?: any) => {
      if (url.endsWith("/v1/files") && init?.method === "POST") return jsonRes({ id: "file_123" });
      if (url.includes("/url")) return jsonRes({ url: "https://signed.example/doc.pdf" });
      if (url.endsWith("/v1/ocr")) return jsonRes({ error: "boom" }, false, 500);
      return jsonRes({ deleted: true });
    });
    const res = await reader(fetchFn).read(writePdf());
    expect((fallback as any).read).toHaveBeenCalled();
    // Provenance must reflect what produced the text (pdf2json), not "pdf:mistral".
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("pdf:pdf2json");
  });
});
