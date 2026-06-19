import * as fs from "fs";
import * as path from "path";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { Turn, packTurns } from "./transcript/turnPacking";

/** YAML-only `readers.chat` knobs (defaults live in `src/config/schema.ts`). */
export interface ChatReaderOptions {
  /** Max messages parsed from one export (warn + truncate beyond). */
  maxMessages: number;
  /** Drop system/service noise (joins, "<Media omitted>", encryption notices, …). */
  skipSystem: boolean;
}

type Platform = "whatsapp" | "telegram" | "discord" | "slack";

// WhatsApp line shapes. iOS brackets the timestamp; Android uses a ` - ` sep.
// Optional seconds / AM-PM / LTR mark (‎). The trailing group is the rest
// of the line (a `Sender: text` message or a system notice without a sender).
const WA_IOS = /^‎?\[(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\]\s*‎?(.*)$/;
const WA_ANDROID = /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)\s+[-–]\s+(.*)$/;
const WA_SENDER = /^([^:]{1,60}?):\s([\s\S]*)$/;
const WA_MEDIA = /^‎?(<media omitted>|image omitted|video omitted|audio omitted|sticker omitted|gif omitted|document omitted|contact card omitted|this message was deleted|you deleted this message|<attached:.*>)$/i;

const DISCORD_SYSTEM = new Set([
  "ChannelPinnedMessage", "GuildMemberJoin", "Call", "RecipientAdd", "RecipientRemove",
  "ChannelNameChange", "ChannelIconChange", "ThreadCreated", "GuildBoost",
]);
const SLACK_SYSTEM_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name",
  "channel_archive", "channel_unarchive", "bot_add", "bot_remove", "group_join", "group_leave",
]);

/**
 * Reads chat-history exports into **size-packed** conversational chunks — the
 * same path as transcripts/email. A message → a `Turn` (sender → `speaker`,
 * timestamp → `occurredAt`/bitemporal `validAt`); the export becomes a
 * provenance-rich conversation graph with no platform-specific logic leaking
 * downstream. Each chunk is stamped `sourceAdapter:"chat:<platform>"`.
 *
 * Sniff-dispatched (registered after TranscriptReader/EmailReader, before
 * Json/Text): a chat-shaped `.txt`/`.json` is claimed; everything else defers.
 *
 *  - **WhatsApp** `.txt` — `[date, time] Sender: msg` (iOS) / `date, time - Sender: msg` (Android),
 *    continuation lines appended, system notices dropped.
 *  - **Telegram** `result.json` — `messages[]`, `text_entities` flattened, `date_unixtime`→ISO.
 *  - **Discord** DiscordChatExporter `.json` — `messages[]`, `author.nickname||name`, `content`.
 *  - **Slack** day-files `.json` — message arrays resolved against the export's `users.json`
 *    sidecar (walked up the dir tree) for `user` id → name and `<@U…>` mentions.
 *
 * v1 deferred: Viber/Signal (non-standard exports), Telegram/Discord HTML, Slack
 * thread→reply edges, attachments.
 */
export class ChatExportReader extends FileReader {
  private readonly maxChunkSize: number;
  private readonly maxMessages: number;
  private readonly skipSystem: boolean;
  private readonly slackUserCache = new Map<string, Map<string, string>>();

  constructor(chunker: TextChunker, logger: Logger, maxChunkSize: number, opts: ChatReaderOptions) {
    super([], chunker, logger); // extension list unused; canRead is overridden
    this.maxChunkSize = maxChunkSize;
    this.maxMessages = opts.maxMessages;
    this.skipSystem = opts.skipSystem;
  }

  getName(): string {
    return "ChatExportReader";
  }

  adapterId(): string {
    return "chat";
  }

  canRead(filePath: string): boolean {
    return this.detectFormat(filePath) !== null;
  }

  async read(filePath: string): Promise<FileReadResult> {
    const platform = this.detectFormat(filePath);
    const raw = await fs.promises.readFile(filePath, "utf-8");
    if (!platform) return this.plainFallback(raw);
    try {
      let turns: Turn[];
      switch (platform) {
        case "whatsapp": turns = this.parseWhatsApp(raw); break;
        case "telegram": turns = this.parseTelegram(JSON.parse(raw)); break;
        case "discord": turns = this.parseDiscord(JSON.parse(raw)); break;
        case "slack": turns = this.parseSlack(JSON.parse(raw), filePath); break;
      }
      if (turns.length === 0) return this.plainFallback(raw);
      if (turns.length > this.maxMessages) {
        this.logger.warn(
          `ChatExportReader: ${filePath} (${platform}) has ${turns.length} messages; truncating to maxMessages=${this.maxMessages}`
        );
        turns = turns.slice(0, this.maxMessages);
      }
      const chunks = await packTurns(turns, filePath, this.maxChunkSize, this.chunker);
      // Per-platform provenance granularity (the ECS payoff); packTurns set the
      // rest (source/speaker/occurredAt). Central stamping prefers this value.
      const sourceAdapter = `chat:${platform}`;
      for (const c of chunks) c.provenance = { ...(c.provenance ?? {}), sourceAdapter };
      return { chunks, metadata: { type: "chat", platform, source: filePath, messages: turns.length } };
    } catch (e) {
      this.logger.warn(
        `ChatExportReader could not parse ${filePath}; falling back to plain chunking: ${e}`
      );
      return this.plainFallback(raw);
    }
  }

  // --- format detection -----------------------------------------------------

  /** Cheap head sniff: claim only chat-shaped `.txt`/`.json`, defer everything else. */
  private detectFormat(filePath: string): Platform | null {
    const lower = filePath.toLowerCase();
    if (!lower.endsWith(".txt") && !lower.endsWith(".json")) return null;
    const head = this.readHead(filePath, 8192);
    if (!head) return null;

    if (lower.endsWith(".txt")) {
      return this.looksWhatsApp(head) ? "whatsapp" : null;
    }
    // .json — string-includes signatures (avoid parsing a possibly-truncated head)
    if (head.includes("Telegram Desktop Export") || (head.includes('"messages"') && head.includes('"text_entities"'))) {
      return "telegram";
    }
    if (head.includes('"exportedAt"') || (head.includes('"guild"') && head.includes('"channel"') && head.includes('"author"'))) {
      return "discord";
    }
    const trimmed = head.replace(/^﻿/, "").trimStart();
    if (trimmed.startsWith("[") && head.includes('"ts"') && head.includes('"type"') && (head.includes('"user"') || head.includes('"subtype"'))) {
      return "slack";
    }
    return null;
  }

  private looksWhatsApp(head: string): boolean {
    const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    return lines.some((l) => WA_IOS.test(l) || WA_ANDROID.test(l));
  }

  private readHead(filePath: string, n: number): string | null {
    try {
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(n);
      const read = fs.readSync(fd, buf, 0, n, 0);
      fs.closeSync(fd);
      return buf.toString("utf8", 0, read);
    } catch {
      return null;
    }
  }

  // --- per-platform parsers -------------------------------------------------

  private parseWhatsApp(raw: string): Turn[] {
    const turns: Turn[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = WA_IOS.exec(line) ?? WA_ANDROID.exec(line);
      if (m) {
        const [, date, time, rest] = m;
        const sm = WA_SENDER.exec(rest);
        if (sm) {
          turns.push({ speaker: sm[1].trim(), text: sm[2], occurredAt: this.waDate(date, time), conversation: 0 });
        } else if (!this.skipSystem) {
          turns.push({ speaker: "system", text: rest, occurredAt: this.waDate(date, time), conversation: 0 });
        }
      } else if (turns.length > 0) {
        turns[turns.length - 1].text += "\n" + line; // continuation of the previous message
      }
      // a line before the first timestamped message is dropped
    }
    return turns
      .map((t) => ({ ...t, text: t.text.trim() }))
      .filter((t) => t.text && !(this.skipSystem && WA_MEDIA.test(t.text)));
  }

  /** Best-effort WhatsApp date (locale-ambiguous D/M vs M/D) → ISO, else undefined. */
  private waDate(d: string, t: string): string | undefined {
    const parts = d.split(/[./-]/).map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return undefined;
    let [a, b, y] = parts;
    let day: number, month: number;
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else { day = a; month = b; } // default D/M/Y (most locales)
    if (y < 100) y += 2000;
    const tm = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
    if (!tm) return undefined;
    let hh = Number(tm[1]);
    const ap = tm[4]?.toLowerCase();
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    const dt = new Date(Date.UTC(y, month - 1, day, hh, Number(tm[2]), Number(tm[3] ?? 0)));
    return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
  }

  private parseTelegram(data: any): Turn[] {
    const msgs: any[] = Array.isArray(data?.messages) ? data.messages : [];
    return msgs
      .filter((m) => !this.skipSystem || m?.type === "message")
      .map((m) => ({
        speaker: String(m?.from ?? m?.from_id ?? "unknown"),
        text: this.telegramText(m),
        occurredAt: this.telegramDate(m),
        conversation: 0,
      }))
      .filter((t) => t.text.trim());
  }

  private telegramText(m: any): string {
    const flatten = (v: any): string =>
      Array.isArray(v) ? v.map((e) => (typeof e === "string" ? e : e?.text ?? "")).join("") : typeof v === "string" ? v : "";
    if (Array.isArray(m?.text_entities)) return flatten(m.text_entities);
    return flatten(m?.text);
  }

  private telegramDate(m: any): string | undefined {
    if (m?.date_unixtime != null) {
      const d = new Date(Number(m.date_unixtime) * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return this.isoOrUndef(m?.date);
  }

  private parseDiscord(data: any): Turn[] {
    const msgs: any[] = Array.isArray(data?.messages) ? data.messages : [];
    return msgs
      .filter((m) => !this.skipSystem || !DISCORD_SYSTEM.has(m?.type))
      .map((m) => ({
        speaker: m?.author?.nickname || m?.author?.name || "unknown",
        text: String(m?.content ?? ""),
        occurredAt: this.isoOrUndef(m?.timestamp),
        conversation: 0,
      }))
      .filter((t) => t.text.trim());
  }

  private parseSlack(data: any, filePath: string): Turn[] {
    const msgs: any[] = Array.isArray(data) ? data : [];
    const users = this.loadSlackUsers(filePath);
    return msgs
      .filter((m) => m?.type === "message" && (!this.skipSystem || !m?.subtype || !SLACK_SYSTEM_SUBTYPES.has(m.subtype)))
      .map((m) => ({
        speaker: users.get(m?.user) ?? m?.username ?? m?.user ?? (m?.bot_id ? "bot" : "unknown"),
        text: this.resolveSlackMentions(String(m?.text ?? ""), users),
        occurredAt: this.slackTs(m?.ts),
        conversation: 0,
      }))
      .filter((t) => t.text.trim());
  }

  /** Walk up from the day-file for the export's `users.json` (id → display name). */
  private loadSlackUsers(filePath: string): Map<string, string> {
    let dir = path.dirname(path.resolve(filePath));
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "users.json");
      const cached = this.slackUserCache.get(candidate);
      if (cached) return cached;
      if (fs.existsSync(candidate)) {
        const map = new Map<string, string>();
        try {
          const arr = JSON.parse(fs.readFileSync(candidate, "utf-8"));
          if (Array.isArray(arr)) {
            for (const u of arr) {
              const name = u?.profile?.display_name || u?.real_name || u?.name;
              if (u?.id && name) map.set(u.id, name);
            }
          }
        } catch { /* unreadable sidecar → ids stay unresolved */ }
        this.slackUserCache.set(candidate, map);
        return map;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return new Map();
  }

  private resolveSlackMentions(text: string, users: Map<string, string>): string {
    return text
      .replace(/<@([A-Z0-9]+)>/g, (_, id) => "@" + (users.get(id) ?? id))
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<(https?:[^|>]+)>/g, "$1");
  }

  private slackTs(ts: any): string | undefined {
    const sec = Number(String(ts).split(".")[0]);
    if (!Number.isFinite(sec) || sec <= 0) return undefined;
    const d = new Date(sec * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  private isoOrUndef(s: any): string | undefined {
    if (typeof s !== "string" || !s.trim()) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  private async plainFallback(raw: string): Promise<FileReadResult> {
    const parts = await this.chunker.chunk(raw);
    return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "chat-fallback" } };
  }
}
