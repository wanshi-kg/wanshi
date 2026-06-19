import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JupyterReader, JupyterReaderOptions } from "./JupyterReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

const NB = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Analysis\n", "We study owl migration."] },
    {
      cell_type: "code",
      source: ["import pandas as pd\n", "print('hello')"],
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hello\n"] },
        { output_type: "execute_result", data: { "text/plain": ["42"] } },
        { output_type: "display_data", data: { "image/png": "aGVsbG8=" } },
        { output_type: "error", ename: "ValueError", traceback: ["boom"] },
      ],
    },
  ],
  metadata: { kernelspec: { language: "python" } },
  nbformat: 4,
});

describe("JupyterReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgipynb-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (opts: JupyterReaderOptions = { includeOutputs: false, includeImages: false }) => {
    const chunker = new TextChunker({ maxChunkSize: 8000, overlapSize: 50, enabled: true }, stubLogger());
    return new JupyterReader(chunker, stubLogger(), opts);
  };
  const write = (content: string) => {
    const p = path.join(tmp, "nb.ipynb");
    fs.writeFileSync(p, content);
    return p;
  };
  const allText = (chunks: { content: string }[]) => chunks.map((c) => c.content).join("\n");

  it("renders markdown narrative + fenced code; outputs off by default", async () => {
    const res = await reader().read(write(NB));
    const text = allText(res.chunks);
    expect(text).toContain("We study owl migration."); // markdown cell
    expect(text).toContain("```python"); // code fenced
    expect(text).toContain("import pandas as pd");
    expect(text).not.toContain("hello\n"); // stream output excluded
    expect(text).not.toContain("Output:");
    expect(res.chunks.every((c) => !c.images || c.images.length === 0)).toBe(true);
  });

  it("includes text outputs when includeOutputs is on (skips error tracebacks)", async () => {
    const res = await reader({ includeOutputs: true, includeImages: false }).read(write(NB));
    const text = allText(res.chunks);
    expect(text).toContain("hello");
    expect(text).toContain("42");
    expect(text).not.toContain("boom"); // error traceback skipped
  });

  it("attaches base64 image outputs as chunk images when includeImages is on", async () => {
    const res = await reader({ includeOutputs: false, includeImages: true }).read(write(NB));
    const withImg = res.chunks.find((c) => c.images && c.images.length > 0);
    expect(withImg).toBeDefined();
    expect(withImg!.images![0].buffer?.toString()).toBe("hello"); // aGVsbG8= → "hello"
  });

  it("falls back gracefully on malformed JSON", async () => {
    const res = await reader().read(write("not json at all { ["));
    expect(Array.isArray(res.chunks)).toBe(true);
  });

  it("claims .ipynb and defers other extensions", () => {
    const r = reader();
    expect(r.canRead("/x/nb.ipynb")).toBe(true);
    expect(r.canRead("/x/data.json")).toBe(false);
    expect(r.adapterId()).toBe("jupyter");
  });
});
