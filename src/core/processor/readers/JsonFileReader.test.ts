import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonFileReader } from "./JsonFileReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("JsonFileReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgjson-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const reader = () => {
    const chunker = new TextChunker(
      { maxChunkSize: 8000, overlapSize: 100, enabled: true },
      stubLogger()
    );
    return new JsonFileReader(
      { strategy: "structural", maxChunkSize: 200 },
      chunker,
      stubLogger()
    );
  };

  it("splits a dominant array into multiple valid-JSON chunks", async () => {
    const data = {
      title: "t",
      conversations: Array.from({ length: 12 }, (_, i) => ({
        id: i,
        text: `hello world message number ${i}`,
      })),
    };
    const file = path.join(tmp, "d.json");
    fs.writeFileSync(file, JSON.stringify(data));

    const res = await reader().read(file);
    expect(res.chunks.length).toBeGreaterThan(1);
    for (const c of res.chunks) {
      expect(() => JSON.parse(c.content)).not.toThrow();
    }
  });

  it("falls back to raw chunking on malformed JSON without throwing", async () => {
    const file = path.join(tmp, "bad.json");
    fs.writeFileSync(file, "{ not: valid json ,,, ");
    const res = await reader().read(file);
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);
    expect(res.chunks[0].content.length).toBeGreaterThan(0);
  });
});
