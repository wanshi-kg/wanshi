import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChandraPdfReader } from "./ChandraPdfReader";
import { FileReader } from "./FileReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("ChandraPdfReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgchandra-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const chunker = () => new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, stubLogger());
  const writePdf = (name = "doc.pdf") => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, "%PDF-1.4 dummy");
    return p;
  };
  const stubFallback = () =>
    ({
      read: jest.fn().mockResolvedValue({
        chunks: [{ content: "PDF2JSON-FALLBACK", index: 1, totalChunks: 1, startOffset: 0, endOffset: 17 }],
      }),
      adapterId: () => "pdf:pdf2json",
    }) as unknown as FileReader & { read: jest.Mock };

  it("reuses a fresh <pdf>.chandra.md sidecar (no subprocess) and chunks it", async () => {
    const p = writePdf();
    fs.writeFileSync(`${p}.chandra.md`, "# Title\n\nChandra OCR'd body text from a handwritten page.");
    const reader = new ChandraPdfReader({ command: "chandra", method: "hf", timeoutMs: 1000 }, stubFallback(), tmp, chunker(), stubLogger());
    const res = await reader.read(p);
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);
    expect(res.chunks.map((c) => c.content).join("\n")).toContain("Chandra OCR'd body");
    expect(res.metadata?.pdfEngine).toBe("chandra");
    expect(res.metadata?.chandraCached).toBe(true);
  });

  it("degrades to the pdf2json fallback when the chandra binary is missing", async () => {
    const fallback = stubFallback();
    const reader = new ChandraPdfReader(
      { command: "kg-gen-no-such-chandra-bin", method: "hf", timeoutMs: 1000 },
      fallback,
      tmp,
      chunker(),
      stubLogger()
    );
    const p = writePdf();
    const res = await reader.read(p);
    expect(fallback.read).toHaveBeenCalledWith(p);
    expect(res.chunks[0].content).toBe("PDF2JSON-FALLBACK");
    // Provenance must reflect what produced the text (pdf2json), not "pdf:chandra" (WS-11).
    expect(res.chunks[0].provenance?.sourceAdapter).toBe("pdf:pdf2json");
  });

  it("claims .pdf, defers other extensions, and tags adapterId", () => {
    const reader = new ChandraPdfReader({ command: "chandra", method: "hf", timeoutMs: 1000 }, stubFallback(), tmp, chunker(), stubLogger());
    expect(reader.canRead("/x/a.pdf")).toBe(true);
    expect(reader.canRead("/x/a.md")).toBe(false);
    expect(reader.adapterId()).toBe("pdf:chandra");
  });
});
