import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({ spawn: (...a: any[]) => mockSpawn(...a) }));

import { DoclingReader } from "./DoclingReader";
import { FileReader, FileReadResult } from "./FileReader";
import { TextChunker } from "../chunking/TextChunker";

const makeLogger = () =>
  ({ trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() } as any);

/**
 * A fake `docling` CLI: locates the `--output` path in args, writes a valid
 * docling JSON there (so parseDoclingOutput succeeds), then exits `code`.
 * When `code !== 0` it writes nothing and exits non-zero (drives the catch).
 */
const fakeDocling = (content: string | null, code: number) => (_cmd: string, args: string[]) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (content !== null && code === 0) {
      const outPath = args[args.indexOf("--output") + 1];
      fs.writeFileSync(outPath, JSON.stringify({ markdown: content, page_count: 1 }));
    }
    child.emit("close", code);
  });
  return child;
};

/** A fake `docling` CLI that never launches (ENOENT-style error event). */
const fakeDoclingError = () => (_cmd: string, _args: string[]) => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => child.emit("error", new Error("spawn docling ENOENT")));
  return child;
};

/** Stub fallback reader (stands in for pdf2json PdfReader). */
const fallbackReader = (): FileReader & { read: jest.Mock } =>
  ({
    read: jest.fn(async (): Promise<FileReadResult> => ({
      chunks: [{ content: "PDF2JSON FALLBACK", index: 1, totalChunks: 1, startOffset: 0, endOffset: 17 }],
      metadata: { type: "pdf", pdfEngine: "pdf2json" },
    })),
    getName: () => "StubFallback",
    adapterId: () => "pdf:pdf2json",
    canRead: () => true,
  } as any);

describe("DoclingReader", () => {
  let tmp: string;
  let logger: any;

  const chunker = () => new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, logger);
  const reader = (fallback?: FileReader) =>
    new DoclingReader(undefined, undefined, undefined, tmp, chunker(), logger, [".pdf"], fallback);

  const writePdf = (name = "doc.pdf") => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.from("%PDF-1.4 fake"));
    return p;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    logger = makeLogger();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgdocling-"));
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("falls back to pdf2json (non-empty) when docling fails, instead of returning empty (WS-10)", async () => {
    mockSpawn.mockImplementation(fakeDoclingError());
    const fallback = fallbackReader();
    const pdf = writePdf();
    const res = await reader(fallback).read(pdf);

    expect(fallback.read).toHaveBeenCalledWith(pdf);
    // The bug: docling returned {chunks:[]} on failure. The fix: a non-empty fallback result.
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks[0].content).toBe("PDF2JSON FALLBACK");
  });

  it("stamps the fallback's adapterId on chunks when the fallback fires (WS-11)", async () => {
    mockSpawn.mockImplementation(fakeDoclingError());
    const fallback = fallbackReader();
    const pdf = writePdf();
    const res = await reader(fallback).read(pdf);

    // Provenance must reflect what produced the text (pdf2json), not "docling".
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("pdf:pdf2json");
  });

  it("returns the legacy empty result when no fallback is wired (back-compat)", async () => {
    mockSpawn.mockImplementation(fakeDoclingError());
    const pdf = writePdf();
    const res = await reader(undefined).read(pdf);
    expect(res.chunks).toHaveLength(0);
    expect(res.metadata?.status).toBe("error");
  });

  it("does NOT write a debug_output_text.txt artifact on the success path (WS-51)", async () => {
    mockSpawn.mockImplementation(fakeDocling("# Title\n\ndocling body text", 0));
    const debugArtifact = path.join(process.cwd(), "debug_output_text.txt");
    const preexisted = fs.existsSync(debugArtifact);
    const pdf = writePdf();
    const res = await reader(fallbackReader()).read(pdf);

    // The success path must produce content WITHOUT leaving a debug file in CWD
    // (the old fire-and-forget `fs.writeFile("debug_output_text.txt", …)`).
    expect(res.chunks[0].content).toContain("docling body text");
    if (!preexisted) {
      expect(fs.existsSync(debugArtifact)).toBe(false);
    }
  });
});
