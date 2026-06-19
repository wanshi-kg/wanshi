import * as fs from "fs";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { Turn, packTurns } from "./transcript/turnPacking";

interface Cue {
  text: string;
  speaker?: string;
}

/**
 * Reads subtitle/caption files (`.srt`, `.vtt`) into clean, **denoised** chunks:
 * the index numbers, timecodes, and styling tags that would otherwise pollute
 * extraction are stripped, leaving the spoken text. When the captions carry
 * speaker info (VTT `<v Speaker>` voice tags) the cues become attributed
 * `Turn`s via the shared `packTurns()` (same path as transcripts/email/chat);
 * otherwise the caption text is concatenated and size-chunked as prose.
 * `sourceAdapter:"subtitle"` is stamped centrally from `adapterId()`.
 *
 * NB (deviation from the data-sinks brief): a cue offset like `00:01:23` is a
 * **media position, not wall-clock valid-time**, so it is NOT written to
 * `occurredAt`/`validAt` (that would fabricate bitemporal data). A cue-time
 * `locator` (à la PDF `p.<n>`) is the right home and is deferred to v2.
 *
 * v1 deferred: cue-time locator, multi-language tracks, karaoke timing tags.
 */
export class SubtitleReader extends FileReader {
  private readonly maxChunkSize: number;

  constructor(chunker: TextChunker, logger: Logger, maxChunkSize: number) {
    super([".srt", ".vtt"], chunker, logger);
    this.maxChunkSize = maxChunkSize;
  }

  getName(): string {
    return "SubtitleReader";
  }

  adapterId(): string {
    return "subtitle";
  }

  async read(filePath: string): Promise<FileReadResult> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    try {
      const cues = this.parseCues(raw);
      if (cues.length === 0) return this.plainFallback(raw);
      const format = filePath.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";

      // Speaker-attributed (VTT <v>) → the turn path; else denoised prose.
      if (cues.some((c) => c.speaker)) {
        const turns: Turn[] = cues.map((c) => ({ speaker: c.speaker || "speaker", text: c.text, conversation: 0 }));
        const chunks = await packTurns(turns, filePath, this.maxChunkSize, this.chunker);
        return { chunks, metadata: { type: "subtitle", format, cues: cues.length } };
      }
      const parts = await this.chunker.chunk(cues.map((c) => c.text).join(" "));
      return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "subtitle", format, cues: cues.length } };
    } catch (e) {
      this.logger.warn(`SubtitleReader could not parse ${filePath}; falling back to plain chunking: ${e}`);
      return this.plainFallback(raw);
    }
  }

  /** SRT blocks and VTT cues → cleaned cue text (+ speaker), consecutive dups dropped. */
  private parseCues(raw: string): Cue[] {
    const blocks = raw.replace(/^﻿/, "").split(/\r?\n\r?\n+/);
    const cues: Cue[] = [];
    let prev = "";
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || /^WEBVTT/.test(trimmed) || /^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;
      const lines = trimmed.split(/\r?\n/);
      const tcIdx = lines.findIndex((l) => l.includes("-->"));
      if (tcIdx === -1) continue; // header / stray block, not a cue
      const textLines = lines.slice(tcIdx + 1);
      if (textLines.length === 0) continue;
      const { text, speaker } = this.cleanCue(textLines.join("\n"));
      if (!text || text === prev) continue; // drop empties + rolling-caption dups
      prev = text;
      cues.push({ text, speaker });
    }
    return cues;
  }

  /** Capture a VTT `<v Speaker>` voice tag, then strip all caption markup. */
  private cleanCue(raw: string): Cue {
    const v = raw.match(/<v(?:\.[^ >]+)?\s+([^>]+)>/i);
    const speaker = v ? v[1].trim() : undefined;
    const text = raw
      .replace(/<[^>]+>/g, "") // <v>, <i>, <b>, <c.class>, inline <00:00:01.000> timestamps
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[ \t]+/g, " ")
      .trim();
    return { text, speaker };
  }

  private async plainFallback(raw: string): Promise<FileReadResult> {
    const parts = await this.chunker.chunk(raw);
    return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "subtitle-fallback" } };
  }
}
