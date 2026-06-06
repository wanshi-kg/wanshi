import * as fs from "fs";
import { ChunkResult, FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { ChunkProvenance } from "../../../types";

/** A normalized conversational turn from any supported transcript format. */
interface Turn {
  speaker: string;
  text: string;
  occurredAt?: string; // ISO-8601 wall-clock time, when known
}

/** Speaker-labeled plain-text transcripts (recua `.parakeet.txt`, etc.). */
const TEXT_SUFFIXES = [
  ".parakeet.txt",
  ".whisper.txt",
  ".corrected.txt",
  ".transcript.txt",
];

/**
 * Reads conversational transcripts into **size-packed** chunks (capped at
 * `maxChunkSize`, tied to the global `chunkSize`) so a long dialogue becomes a
 * handful of chunks instead of one-per-turn. Each turn is rendered inline as
 * `speaker: text` so attribution stays visible to the model, and chunk
 * provenance carries the speaker whenever a chunk happens to be single-speaker.
 *
 * Handles three real shapes:
 *  - recua speaker-labeled text  (`SPEAKER_XX: …` blocks)
 *  - recua turns JSON            (`[{ start, end, speaker, <backend>: text }]`)
 *  - Claude/ChatGPT chat export  (`[{ chat_messages: [{ sender, created_at, … }] }]`)
 *
 * Registered before JsonFileReader/TextReader; `canRead` claims only files that
 * sniff as transcripts, deferring everything else.
 */
export class TranscriptReader extends FileReader {
  private readonly maxChunkSize: number;

  constructor(chunker: TextChunker, logger: Logger, maxChunkSize = 4000) {
    super([], chunker, logger); // extension list unused; canRead is overridden
    this.maxChunkSize = maxChunkSize;
  }

  getName(): string {
    return "TranscriptReader";
  }

  canRead(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (TEXT_SUFFIXES.some((s) => lower.endsWith(s))) return true;
    if (lower.endsWith(".json")) return this.sniffJsonTranscript(filePath);
    return false;
  }

  /** Cheap content sniff (first 8 KB) to claim only transcript-shaped JSON. */
  private sniffJsonTranscript(filePath: string): boolean {
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      const head = buf.toString("utf8", 0, n);
      // Claude/ChatGPT export
      if (head.includes('"chat_messages"') && head.includes('"sender"')) return true;
      // recua turns array
      if (
        /"speaker"\s*:/.test(head) &&
        /"start"\s*:/.test(head) &&
        /"end"\s*:/.test(head)
      )
        return true;
      return false;
    } catch {
      return false;
    }
  }

  async read(filePath: string): Promise<FileReadResult> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    let turns: Turn[];
    try {
      turns = this.parse(filePath, raw);
    } catch (e) {
      this.logger.warn(
        `TranscriptReader could not parse ${filePath}; falling back to plain chunking: ${e}`
      );
      return this.plainFallback(raw);
    }
    if (turns.length === 0) return this.plainFallback(raw);
    return this.chunkTurns(turns, filePath);
  }

  private parse(filePath: string, raw: string): Turn[] {
    if (filePath.toLowerCase().endsWith(".json")) {
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data[0]?.chat_messages !== undefined) {
        return this.parseChatExport(data);
      }
      if (Array.isArray(data) && data[0]?.speaker !== undefined) {
        return this.parseRecuaTurns(data);
      }
      throw new Error("unrecognized transcript JSON shape");
    }
    return this.parseSpeakerText(raw);
  }

  /** "SPEAKER_XX: text" blocks separated by blank lines. */
  private parseSpeakerText(raw: string): Turn[] {
    const labelRe = /^([A-Za-z0-9_][\w .\-]{0,40}?):\s+/;
    const blocks = raw
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    const turns: Turn[] = [];
    for (const block of blocks) {
      const m = block.match(labelRe);
      if (m) {
        turns.push({ speaker: m[1].trim(), text: block.slice(m[0].length).trim() });
      } else if (turns.length > 0) {
        turns[turns.length - 1].text += " " + block; // continuation
      } else {
        turns.push({ speaker: "UNKNOWN", text: block });
      }
    }
    return turns;
  }

  private parseRecuaTurns(data: any[]): Turn[] {
    return data
      .map((t) => ({
        speaker: String(t.speaker ?? "UNKNOWN"),
        text: this.pickRecuaText(t),
      }))
      .filter((t) => t.text);
  }

  private pickRecuaText(t: any): string {
    for (const k of ["corrected", "parakeet", "whisper"]) {
      if (typeof t[k] === "string" && t[k].trim()) return t[k].trim();
    }
    for (const [k, v] of Object.entries(t)) {
      if (k === "start" || k === "end" || k === "speaker") continue;
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }

  private parseChatExport(convs: any[]): Turn[] {
    const turns: Turn[] = [];
    for (const conv of convs) {
      for (const msg of conv.chat_messages ?? []) {
        const text = this.chatMessageText(msg);
        if (!text) continue;
        turns.push({
          speaker: String(msg.sender ?? "unknown"),
          text,
          occurredAt: typeof msg.created_at === "string" ? msg.created_at : undefined,
        });
      }
    }
    return turns;
  }

  private chatMessageText(msg: any): string {
    if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .join(" ")
        .trim();
    }
    return "";
  }

  /** Render a turn with its inline speaker label (`speaker: text`). */
  private render(turn: Turn): string {
    return `${turn.speaker}: ${turn.text}`;
  }

  /**
   * Pack consecutive turns into chunks up to `maxChunkSize` (regardless of
   * speaker), rendering each turn inline as `speaker: text`. Provenance carries
   * the speaker only when a chunk turns out to be single-speaker; a turn longer
   * than the budget on its own is split with the label kept on every piece.
   */
  private async chunkTurns(turns: Turn[], filePath: string): Promise<FileReadResult> {
    const SEP = "\n\n";
    const chunks: ChunkResult[] = [];
    let buf: Turn[] = [];
    const renderLen = (t: Turn) => this.render(t).length;
    const bufLen = () => buf.reduce((n, t) => n + renderLen(t) + SEP.length, 0);

    const flush = () => {
      if (buf.length === 0) return;
      const speakers = new Set(buf.map((t) => t.speaker));
      const occurredAt = buf.find((t) => t.occurredAt)?.occurredAt;
      const text = buf.map((t) => this.render(t)).join(SEP).trim();
      const provenance: ChunkProvenance = {
        source: filePath,
        ...(speakers.size === 1 && { speaker: buf[0].speaker }),
        ...(occurredAt && { occurredAt }),
      };
      chunks.push({ content: text, index: 0, totalChunks: 0, startOffset: 0, endOffset: text.length, provenance });
      buf = [];
    };

    // Split a single oversized turn, keeping its speaker label on each piece.
    const flushOversized = async (turn: Turn) => {
      const provenance: ChunkProvenance = {
        source: filePath,
        speaker: turn.speaker,
        ...(turn.occurredAt && { occurredAt: turn.occurredAt }),
      };
      for (const p of await this.chunker.chunk(turn.text)) {
        const content = `${turn.speaker}: ${p.content}`;
        chunks.push({ content, index: 0, totalChunks: 0, startOffset: p.startOffset, endOffset: p.endOffset, provenance });
      }
    };

    for (const turn of turns) {
      if (!turn.text) continue;
      if (renderLen(turn) > this.maxChunkSize) {
        flush();
        await flushOversized(turn);
        continue;
      }
      if (buf.length > 0 && bufLen() + renderLen(turn) + SEP.length > this.maxChunkSize) {
        flush();
      }
      buf.push(turn);
    }
    flush();

    chunks.forEach((c, i) => {
      c.index = i + 1;
      c.totalChunks = chunks.length;
    });
    return {
      chunks,
      metadata: { type: "transcript", source: filePath, turns: turns.length },
    };
  }

  private async plainFallback(raw: string): Promise<FileReadResult> {
    const parts = await this.chunker.chunk(raw);
    return {
      chunks: parts.map((p) => ({ ...p })),
      metadata: { type: "transcript-fallback" },
    };
  }
}
