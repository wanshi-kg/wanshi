import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SubtitleReader } from "./SubtitleReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("SubtitleReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgsub-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (maxChunkSize = 4000) => {
    const chunker = new TextChunker({ maxChunkSize, overlapSize: 50, enabled: true }, stubLogger());
    return new SubtitleReader(chunker, stubLogger(), maxChunkSize);
  };
  const write = (name: string, content: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const allText = (chunks: { content: string }[]) => chunks.map((c) => c.content).join("\n");

  it("SRT — strips index/timecodes/tags, dedupes consecutive captions", async () => {
    const p = write(
      "movie.srt",
      [
        "1", "00:00:01,000 --> 00:00:04,000", "Hello world", "",
        "2", "00:00:04,000 --> 00:00:06,000", "<i>This is italic</i>", "",
        "3", "00:00:06,000 --> 00:00:08,000", "This is italic", "",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Hello world");
    expect(text).toContain("This is italic");
    expect(text).not.toContain("00:00:01"); // timecode gone
    expect(text).not.toContain("-->");
    expect(text).not.toContain("<i>"); // tag stripped
    expect((text.match(/This is italic/g) || []).length).toBe(1); // consecutive dup dropped
  });

  it("VTT with <v Speaker> → attributed turns; skips WEBVTT/NOTE", async () => {
    const p = write(
      "talk.vtt",
      [
        "WEBVTT", "", "NOTE this is a comment block", "",
        "00:00:01.000 --> 00:00:03.000", "<v Alice>Hello Bob", "",
        "00:00:03.000 --> 00:00:05.000", "<v Bob>Hi Alice", "",
      ].join("\n")
    );
    const res = await reader().read(p);
    const text = allText(res.chunks);
    expect(text).toContain("Alice: Hello Bob"); // voice tag → speaker label
    expect(text).toContain("Bob: Hi Alice");
    expect(text).not.toContain("WEBVTT");
    expect(text).not.toContain("this is a comment block"); // NOTE block skipped
  });

  it("keeps speaker provenance when a VTT chunk is single-speaker", async () => {
    const p = write(
      "mono.vtt",
      ["WEBVTT", "", "00:00:01.000 --> 00:00:03.000", "<v Alice>One", "", "00:00:03.000 --> 00:00:05.000", "<v Alice>Two", ""].join("\n")
    );
    const res = await reader().read(p);
    expect(res.chunks[0].provenance?.speaker).toBe("Alice");
  });

  it("does not throw on a subtitle file with no cues (graceful)", async () => {
    const p = write("empty.srt", "just some random text\nwith no timecodes at all");
    const res = await reader().read(p);
    expect(Array.isArray(res.chunks)).toBe(true);
  });

  it("claims .srt/.vtt and defers other extensions", () => {
    const r = reader();
    expect(r.canRead("/x/a.srt")).toBe(true);
    expect(r.canRead("/x/a.vtt")).toBe(true);
    expect(r.canRead("/x/notes.md")).toBe(false);
    expect(r.adapterId()).toBe("subtitle");
  });
});
