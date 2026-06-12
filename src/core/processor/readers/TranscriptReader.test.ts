import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TranscriptReader } from "./TranscriptReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

describe("TranscriptReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgtr-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const reader = (maxChunkSize = 4000) => {
    const chunker = new TextChunker(
      { maxChunkSize, overlapSize: 50, enabled: true },
      stubLogger()
    );
    return new TranscriptReader(chunker, stubLogger(), maxChunkSize);
  };

  const write = (name: string, content: string) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it("packs a small dialogue into one chunk with inline speaker labels", async () => {
    const p = write(
      "lesson.parakeet.txt",
      "SPEAKER_00: first part here.\n\nSPEAKER_00: second part here.\n\nSPEAKER_01: a reply from the other side."
    );
    const res = await reader().read(p);
    // everything fits one chunk; speaker labels stay inline so attribution is visible
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].content).toContain("SPEAKER_00: first part here.");
    expect(res.chunks[0].content).toContain("SPEAKER_01: a reply");
    // mixed-speaker chunk → no single speaker on provenance, but source is kept
    expect(res.chunks[0].provenance?.speaker).toBeUndefined();
    expect(res.chunks[0].provenance?.source).toBe(p);
  });

  it("keeps speaker provenance when a packed chunk is single-speaker", async () => {
    const p = write(
      "mono.parakeet.txt",
      "SPEAKER_00: first part here.\n\nSPEAKER_00: second part here."
    );
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].provenance?.speaker).toBe("SPEAKER_00");
  });

  it("splits across chunks by size while keeping labels, not one-per-turn", async () => {
    // 6 short turns; a tiny budget forces multiple chunks but far fewer than 6
    const body = Array.from({ length: 6 }, (_, i) =>
      `SPEAKER_${i % 2 === 0 ? "00" : "01"}: turn number ${i} talking here.`
    ).join("\n\n");
    const p = write("chatty.parakeet.txt", body);
    const res = await reader(120).read(p);
    expect(res.chunks.length).toBeGreaterThan(1);
    expect(res.chunks.length).toBeLessThan(6);
    expect(res.chunks.every((c) => /SPEAKER_0[01]:/.test(c.content))).toBe(true);
  });

  it("parses recua turns JSON, packing both turns into one labeled chunk", async () => {
    const p = write(
      "lesson.json",
      JSON.stringify([
        { start: 0, end: 2, speaker: "SPEAKER_00", parakeet: "alpha beta gamma" },
        { start: 2, end: 4, speaker: "SPEAKER_01", parakeet: "delta epsilon zeta" },
      ])
    );
    expect(reader().canRead(p)).toBe(true);
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].content).toContain("SPEAKER_00: alpha beta gamma");
    expect(res.chunks[0].content).toContain("SPEAKER_01: delta epsilon zeta");
  });

  it("parses Claude chat-export JSON, keeping earliest timestamp on the packed chunk", async () => {
    const p = write(
      "conversations.json",
      JSON.stringify([
        {
          chat_messages: [
            { sender: "human", created_at: "2025-01-01T00:00:00Z", text: "what is recursion" },
            {
              sender: "assistant",
              created_at: "2025-01-01T00:00:05Z",
              content: [{ type: "text", text: "a function that calls itself" }],
            },
          ],
        },
      ])
    );
    expect(reader().canRead(p)).toBe(true);
    const res = await reader().read(p);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].content).toContain("human: what is recursion");
    expect(res.chunks[0].content).toContain("assistant: a function that calls itself");
    expect(res.chunks[0].provenance?.occurredAt).toBe("2025-01-01T00:00:00Z");
  });

  it("never packs two conversations into one chunk; stamps per-conversation time (KG-10)", async () => {
    // Two short conversations that would fit in a single chunk if flattened.
    const p = write(
      "conversations.json",
      JSON.stringify([
        {
          chat_messages: [
            { sender: "human", created_at: "2025-01-01T00:00:00Z", text: "conv one alpha" },
            { sender: "assistant", created_at: "2025-01-01T00:00:05Z", text: "conv one beta" },
          ],
        },
        {
          chat_messages: [
            { sender: "human", created_at: "2025-06-06T12:00:00Z", text: "conv two gamma" },
            { sender: "assistant", created_at: "2025-06-06T12:00:05Z", text: "conv two delta" },
          ],
        },
      ])
    );
    const res = await reader().read(p);
    // One chunk per conversation — no cross-conversation bleed.
    expect(res.chunks).toHaveLength(2);
    expect(res.chunks[0].content).toContain("conv one");
    expect(res.chunks[0].content).not.toContain("conv two");
    expect(res.chunks[1].content).toContain("conv two");
    expect(res.chunks[1].content).not.toContain("conv one");
    // Distinct per-conversation occurredAt → distinct validAt downstream.
    expect(res.chunks[0].provenance?.occurredAt).toBe("2025-01-01T00:00:00Z");
    expect(res.chunks[1].provenance?.occurredAt).toBe("2025-06-06T12:00:00Z");
  });

  it("defers non-transcript files (plain .txt and ordinary .json)", async () => {
    const txt = write("notes.txt", "just some prose without speakers");
    const json = write("data.json", JSON.stringify({ a: 1, b: [2, 3] }));
    const r = reader();
    expect(r.canRead(txt)).toBe(false);
    expect(r.canRead(json)).toBe(false);
  });
});
