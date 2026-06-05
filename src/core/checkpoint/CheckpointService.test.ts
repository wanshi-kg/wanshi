import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CheckpointService } from "./CheckpointService";
import { stubLogger } from "../../__tests__/helpers";

describe("CheckpointService", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgckpt-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const svc = () =>
    new CheckpointService(path.join(tmp, "c.jsonl"), stubLogger());

  it("computeKey is deterministic and sensitive to the path id", () => {
    const s = svc();
    const a = s.computeKey("a.txt", 1, "content", "m", "v");
    const b = s.computeKey("a.txt", 1, "content", "m", "v");
    const c = s.computeKey("b.txt", 1, "content", "m", "v");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("append/has/get round-trips and load() restores from disk", async () => {
    const s = svc();
    const key = s.computeKey("a.txt", 1, "x", "m", "v");
    const kg = {
      entities: [
        { name: "E", entityType: "t", observations: ["o"], files: [] },
      ],
      relations: [],
    };
    await s.append({
      key,
      filePath: "a.txt",
      chunkIndex: 1,
      totalChunks: 1,
      model: "m",
      promptVersion: "v",
      kg,
    });
    expect(s.has(key)).toBe(true);
    expect(s.get(key)).toEqual(kg);

    const s2 = new CheckpointService(s.getPath(), stubLogger());
    const loaded = await s2.load();
    expect(loaded).toBe(1);
    expect(s2.has(key)).toBe(true);
  });

  it("load() tolerates a truncated final line", async () => {
    const file = path.join(tmp, "c.jsonl");
    const good = JSON.stringify({
      key: "k1",
      filePath: "a",
      chunkIndex: 1,
      totalChunks: 1,
      kg: { entities: [], relations: [] },
    });
    // second line is cut off mid-write (interrupted append)
    fs.writeFileSync(file, good + "\n" + '{"key":"k2","filePath":"b","chunkIndex":2,');
    const s = new CheckpointService(file, stubLogger());
    const loaded = await s.load();
    expect(loaded).toBe(1);
    expect(s.has("k1")).toBe(true);
    expect(s.has("k2")).toBe(false);
  });
});
