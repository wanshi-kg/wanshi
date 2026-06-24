import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({ spawn: (...a: any[]) => mockSpawn(...a) }));

import { MarkerPdfReader, MarkerOptions } from "./MarkerPdfReader";
import { FileReader, FileReadResult } from "./FileReader";
import { TextChunker } from "../chunking/TextChunker";

const makeLogger = () =>
  ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() } as any);

/** A fake marker_single: writes `<output_dir>/<stem>/<stem>.md`, exits `code`. */
const fakeMarker = (markdown: string | null, code: number) => (_cmd: string, args: string[]) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (markdown !== null) {
      const outDir = args[args.indexOf("--output_dir") + 1];
      const pdfArg = args[0];
      const stem = path.basename(pdfArg, path.extname(pdfArg));
      const dir = path.join(outDir, stem);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${stem}.md`), markdown);
    }
    child.emit("close", code);
  });
  return child;
};

/** Stub fallback reader (stands in for pdf2json PdfReader). */
const fallbackReader = (): FileReader => {
  const r: any = {
    read: jest.fn(async (): Promise<FileReadResult> => ({
      chunks: [{ content: "PDF2JSON FALLBACK", index: 1, totalChunks: 1, startOffset: 0, endOffset: 17 }],
      metadata: { type: "pdf", pdfEngine: "pdf2json" },
    })),
    getName: () => "StubFallback",
    adapterId: () => "pdf:pdf2json",
    canRead: () => true,
  };
  return r as FileReader;
};

describe("MarkerPdfReader", () => {
  let tmp: string;
  let logger: any;
  let fallback: FileReader;
  const opts: MarkerOptions = { command: "marker_single", useLlm: false, forceOcr: false, timeoutMs: 5000 };

  const reader = (o: Partial<MarkerOptions> = {}) => {
    const chunker = new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, logger);
    return new MarkerPdfReader({ ...opts, ...o }, undefined, fallback, tmp, chunker, logger);
  };

  const writePdf = (name = "doc.pdf") => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.from("%PDF-1.4 fake"));
    return p;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    logger = makeLogger();
    fallback = fallbackReader();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgmk-"));
    mockSpawn.mockImplementation(fakeMarker("# Title\n\nbody text from marker", 0));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs marker and returns its markdown as a chunk", async () => {
    const pdf = writePdf();
    const res = await reader().read(pdf);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(["--output_format", "markdown"]));
    expect(res.metadata?.pdfEngine).toBe("marker");
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].content).toContain("body text from marker");
    expect((fallback as any).read).not.toHaveBeenCalled();
  });

  it("passes --use_llm and --force_ocr when configured", async () => {
    const pdf = writePdf();
    await reader({ useLlm: true, forceOcr: true }).read(pdf);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain("--use_llm");
    expect(args).toContain("--force_ocr");
  });

  it("reuses a fresh sidecar instead of re-running marker", async () => {
    const pdf = writePdf();
    fs.writeFileSync(`${pdf}.marker.md`, "# cached\n\ncached body");
    const res = await reader().read(pdf);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(res.metadata?.markerCached).toBe(true);
    expect(res.chunks[0].content).toContain("cached body");
  });

  it("falls back to pdf2json when marker exits non-zero", async () => {
    mockSpawn.mockImplementation(fakeMarker(null, 1));
    const pdf = writePdf();
    const res = await reader().read(pdf);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to pdf2json"));
    expect((fallback as any).read).toHaveBeenCalledWith(pdf);
    expect(res.chunks[0].content).toBe("PDF2JSON FALLBACK");
  });

  it("stamps the fallback's adapterId on chunks when the fallback fires (WS-11)", async () => {
    mockSpawn.mockImplementation(fakeMarker(null, 1));
    const pdf = writePdf();
    const res = await reader().read(pdf);
    expect((fallback as any).read).toHaveBeenCalledWith(pdf);
    // Provenance must reflect what produced the text (pdf2json), not "pdf:marker".
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("pdf:pdf2json");
  });
});
