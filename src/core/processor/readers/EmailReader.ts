import * as fs from "fs";
import { simpleParser, ParsedMail } from "mailparser";
import type { HtmlToTextOptions } from "html-to-text";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { Turn, packTurns } from "./transcript/turnPacking";

/** YAML-only `readers.email` knobs (defaults live in `src/config/schema.ts`). */
export interface EmailReaderOptions {
  /** Max messages parsed from one `.mbox` (warn + truncate beyond). */
  maxMessages: number;
  /** Strip quoted reply chains so each message contributes only its new content. */
  stripQuotes: boolean;
}

/**
 * html-to-text profile for email bodies — rescued from the kg-mail-assistant
 * prototype's `MailListener`: preserve document structure (headings, lists,
 * blockquotes, tables) while dropping boilerplate (script/style/nav/footer/ads).
 */
const EMAIL_HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    // uppercase:false — preserve original case so entity names aren't SHOUTED.
    { selector: "h1", format: "heading", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: "h2", format: "heading", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: "h3", format: "heading", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: "h4", format: "heading", options: { uppercase: false, leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "p", format: "paragraph", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "br", format: "lineBreak" },
    { selector: "ul", format: "unorderedList", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "ol", format: "orderedList", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "li", format: "listItem", options: { leadingLineBreaks: 1 } },
    { selector: "blockquote", format: "blockquote", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "table", format: "table" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "nav", format: "skip" },
    { selector: "header", format: "skip" },
    { selector: "footer", format: "skip" },
    { selector: ".navigation", format: "skip" },
    { selector: ".sidebar", format: "skip" },
    { selector: ".footer", format: "skip" },
    { selector: ".header", format: "skip" },
    { selector: ".menu", format: "skip" },
    { selector: ".advertisement", format: "skip" },
    { selector: ".ads", format: "skip" },
  ],
};

/**
 * Reads email (`.eml`, `.mbox`) into **size-packed** chunks by treating each
 * message as a conversational turn — the same path as transcripts/chat exports.
 * Sender → `speaker`, the `Date:` header → `occurredAt` (the observation's
 * bitemporal `validAt`), so an email thread becomes a provenance-rich
 * conversation graph with no email-specific logic leaking downstream.
 *
 * A `.mbox` is split into its messages (`From ` envelope lines); messages from
 * different threads (`References`/`In-Reply-To` root) are tagged with distinct
 * `conversation` ids so `packTurns` never packs two threads into one chunk
 * (KG-10). HTML-only bodies are decoded with a structure-preserving,
 * boilerplate-stripping html-to-text profile; quoted reply chains are stripped
 * so a reply contributes its new content, not N copies of the thread.
 *
 * Registered before TextReader/BinaryReader so `.eml`/`.mbox` (otherwise
 * unclaimed → skipped as binary) route here. `sourceAdapter:"email"` is stamped
 * centrally by FileProcessor from `adapterId()`.
 *
 * v1 scope: `.eml` + `.mbox`. Deferred — `.msg` (binary Outlook); explicit
 * `In-Reply-To → reply_to` edges (a packed chunk can span messages, so a single
 * per-chunk `locator:msgid` is ambiguous too); attachment extraction.
 */
export class EmailReader extends FileReader {
  private readonly maxChunkSize: number;
  private readonly maxMessages: number;
  private readonly stripQuotes: boolean;

  constructor(chunker: TextChunker, logger: Logger, maxChunkSize: number, opts: EmailReaderOptions) {
    super([".eml", ".mbox"], chunker, logger);
    this.maxChunkSize = maxChunkSize;
    this.maxMessages = opts.maxMessages;
    this.stripQuotes = opts.stripQuotes;
  }

  getName(): string {
    return "EmailReader";
  }

  adapterId(): string {
    return "email";
  }

  async read(filePath: string): Promise<FileReadResult> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    try {
      const blocks = filePath.toLowerCase().endsWith(".mbox") ? this.splitMbox(raw) : [raw];
      if (blocks.length === 0) return this.plainFallback(raw);

      let limited = blocks;
      if (blocks.length > this.maxMessages) {
        this.logger.warn(
          `EmailReader: ${filePath} has ${blocks.length} messages; truncating to maxMessages=${this.maxMessages}`
        );
        limited = blocks.slice(0, this.maxMessages);
      }

      const threadIndex = new Map<string, number>();
      const turns: Turn[] = [];
      for (const block of limited) {
        const turn = await this.messageToTurn(block, threadIndex);
        if (turn) turns.push(turn);
      }
      if (turns.length === 0) return this.plainFallback(raw);

      const chunks = await packTurns(turns, filePath, this.maxChunkSize, this.chunker);
      return { chunks, metadata: { type: "email", source: filePath, messages: turns.length } };
    } catch (e) {
      this.logger.warn(
        `EmailReader could not parse ${filePath}; falling back to plain chunking: ${e}`
      );
      return this.plainFallback(raw);
    }
  }

  /** Parse one RFC822 message into a conversational turn (null if empty). */
  private async messageToTurn(block: string, threadIndex: Map<string, number>): Promise<Turn | null> {
    const parsed = await simpleParser(block);

    // Prefer the HTML part (decoded with our boilerplate-stripping profile) over
    // mailparser's auto-generated `text` — for HTML-only mail mailparser populates
    // `text` itself, but without skipping nav/footer/ads, so our selectors win.
    let body = parsed.html
      ? (await this.htmlToText(parsed.html)).trim()
      : (parsed.text ?? "").trim();
    if (this.stripQuotes) body = this.stripQuotedReplies(body).trim();

    const subject = (parsed.subject ?? "").trim();
    if (!body && !subject) return null;

    const text = subject ? `Subject: ${subject}\n${body}`.trim() : body;
    const occurredAt =
      parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
        ? parsed.date.toISOString()
        : undefined;

    return {
      speaker: this.senderName(parsed.from),
      text,
      occurredAt,
      conversation: this.threadIndexFor(parsed, threadIndex),
    };
  }

  /** Display name from `From:` (`Name <addr>` → Name, else the address). */
  private senderName(from: ParsedMail["from"]): string {
    const v = from?.value?.[0];
    if (v?.name && v.name.trim()) return v.name.trim();
    if (v?.address && v.address.trim()) return v.address.trim();
    if (from?.text && from.text.trim()) return from.text.trim();
    return "unknown";
  }

  /**
   * Map a message to a 0-based thread index by its conversation root
   * (`References[0]` ?? `In-Reply-To` ?? own `Message-ID`), so distinct threads
   * in one `.mbox` get distinct `conversation` ids and never share a chunk.
   */
  private threadIndexFor(parsed: ParsedMail, map: Map<string, number>): number {
    const refs = parsed.references;
    const root = Array.isArray(refs)
      ? refs[0]
      : typeof refs === "string"
        ? refs.trim().split(/\s+/)[0]
        : undefined;
    const key = (root ?? parsed.inReplyTo ?? parsed.messageId ?? `__${map.size}`).trim();
    if (!map.has(key)) map.set(key, map.size);
    return map.get(key)!;
  }

  /** Split an mbox into RFC822 message blocks on `From ` envelope lines. */
  private splitMbox(raw: string): string[] {
    const fromLine = /^From .+\b(?:19|20)\d{2}\b/;
    const blocks: string[] = [];
    let cur: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (fromLine.test(line)) {
        if (cur.length > 0) {
          blocks.push(cur.join("\n"));
          cur = [];
        }
        continue; // drop the envelope line itself
      }
      // Unescape mbox quoting: ">From " → "From ", ">>From " → ">From ".
      cur.push(line.replace(/^>(>*From )/, "$1"));
    }
    if (cur.length > 0) blocks.push(cur.join("\n"));
    return blocks.map((b) => b.trim()).filter(Boolean);
  }

  private async htmlToText(html: string): Promise<string> {
    const { convert } = await import("html-to-text");
    return convert(html, EMAIL_HTML_OPTIONS);
  }

  /**
   * Light, best-effort quote stripping: cut the body at the first quote-chain
   * marker ("On … wrote:" / "----- Original Message -----") and drop surviving
   * leading-`>` lines. Not a full reply parser — keeps each message's own prose.
   */
  private stripQuotedReplies(body: string): string {
    const onWrote = /^\s*On\b.*\bwrote:\s*$/i;
    const origMsg = /^\s*-{2,}\s*Original Message\s*-{2,}/i;
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (onWrote.test(line) || origMsg.test(line)) break;
      out.push(line);
    }
    return out.filter((l) => !/^\s*>/.test(l)).join("\n");
  }

  private async plainFallback(raw: string): Promise<FileReadResult> {
    const parts = await this.chunker.chunk(raw);
    return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "email-fallback" } };
  }
}
