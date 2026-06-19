import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ImageReader } from "./ImageReader";
import { IObjectDetector } from "../../../types/IObjectDetector";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("ImageReader — CV detection integration", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgimg-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const chunker = () => new TextChunker({ maxChunkSize: 4000, overlapSize: 50, enabled: true }, stubLogger());
  const offOpts = { exif: false, c2pa: { enabled: false, command: "c2patool" } };
  const writeImg = (name = "pic.jpg") => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // bytes are never parsed here
    return p;
  };
  const box = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

  it("appends a detection summary to the chunk content + stashes metadata.cvDetection", async () => {
    const detector: IObjectDetector = {
      detect: async () => [
        { label: "person", score: 0.9, box },
        { label: "person", score: 0.8, box },
        { label: "motorbike", score: 0.7, box },
      ],
    };
    const reader = new ImageReader(chunker(), stubLogger(), offOpts, detector);
    const res = await reader.read(writeImg());
    expect(res.chunks[0].content).toContain("[Image file: pic.jpg]");
    expect(res.chunks[0].content).toContain("CV pre-pass detected: person ×2, motorbike");
    expect(res.metadata?.cvDetection?.objects).toHaveLength(3);
  });

  it("leaves content unchanged when no detector is injected (byte-identical default)", async () => {
    const reader = new ImageReader(chunker(), stubLogger(), offOpts);
    const res = await reader.read(writeImg());
    expect(res.chunks[0].content).toBe("[Image file: pic.jpg]");
    expect(res.metadata?.cvDetection).toBeUndefined();
  });

  it("adds no summary when the detector returns nothing", async () => {
    const detector: IObjectDetector = { detect: async () => [] };
    const reader = new ImageReader(chunker(), stubLogger(), offOpts, detector);
    const res = await reader.read(writeImg());
    expect(res.chunks[0].content).toBe("[Image file: pic.jpg]");
    expect(res.metadata?.cvDetection).toBeUndefined();
  });
});
