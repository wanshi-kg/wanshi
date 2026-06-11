import * as fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { NormalizedMessage, Attachment } from "../ingest/types";
import { extractUrls } from "../util/url";
import { inboxBinaryPath } from "../ingest/inboxWriter";

export type MessageHandler = (msg: NormalizedMessage) => Promise<void>;

/**
 * Thin wrapper over node-telegram-bot-api: long-polls, enforces a user allow-list,
 * normalizes incoming messages, and downloads attachments into the inbox.
 */
export class Bot {
  private readonly bot: TelegramBot;

  constructor(
    token: string,
    private readonly allowedUserIds: number[],
    private readonly inboxDir: string,
    private readonly log: (msg: string) => void
  ) {
    this.bot = new TelegramBot(token, { polling: true });
  }

  start(onMessage: MessageHandler): void {
    this.bot.on("message", async (raw) => {
      try {
        const userId = raw.from?.id;
        if (userId === undefined) return;
        if (!this.isAllowed(userId)) {
          this.log(`ignoring message from non-allowed user ${userId}`);
          await this.send(raw.chat.id, "Sorry, this is a private sink.");
          return;
        }
        if (raw.text && raw.text.startsWith("/")) {
          await this.handleCommand(raw);
          return;
        }
        const msg = this.normalize(raw);
        await onMessage(msg);
      } catch (err) {
        this.log(`message handler error: ${err}`);
      }
    });
    this.bot.on("polling_error", (err) => this.log(`polling_error: ${err.message}`));
    this.log("bot listening (long-poll)");
  }

  async send(chatId: number, text: string): Promise<void> {
    await this.bot.sendMessage(chatId, text, { disable_web_page_preview: true });
  }

  /** IngestContext.downloadFile: pull a Telegram file into the inbox. */
  downloadFile = async (fileId: string, suggestedName: string): Promise<string> => {
    const link = await this.bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = inboxBinaryPath(this.inboxDir, suggestedName);
    fs.writeFileSync(dest, buf);
    return dest;
  };

  private isAllowed(userId: number): boolean {
    if (this.allowedUserIds.length === 0) return true; // open mode (discouraged)
    return this.allowedUserIds.includes(userId);
  }

  private async handleCommand(raw: TelegramBot.Message): Promise<void> {
    const cmd = (raw.text ?? "").split(/\s+/)[0].toLowerCase();
    if (cmd === "/start" || cmd === "/help") {
      await this.send(
        raw.chat.id,
        [
          "Forward me articles, videos, posts, files or contacts and I'll fold them into a knowledge graph.",
          "",
          "Supported now: web articles, YouTube transcripts, plain/forwarded text, contacts, PDFs/Office docs.",
          "Partial (metadata only): TikTok, generic video, channel links.",
        ].join("\n")
      );
    } else {
      await this.send(raw.chat.id, "Just send me content — no commands needed.");
    }
  }

  private normalize(raw: TelegramBot.Message): NormalizedMessage {
    const text = raw.text ?? raw.caption ?? undefined;
    const msg: NormalizedMessage = {
      userId: raw.from!.id,
      chatId: raw.chat.id,
      text,
      urls: extractUrls(text),
    };

    if (raw.contact) {
      msg.contact = {
        firstName: raw.contact.first_name,
        lastName: raw.contact.last_name,
        phoneNumber: raw.contact.phone_number,
        userId: raw.contact.user_id,
      };
    }

    const attachment = this.normalizeAttachment(raw);
    if (attachment) msg.attachment = attachment;

    return msg;
  }

  private normalizeAttachment(raw: TelegramBot.Message): Attachment | undefined {
    if (raw.document) {
      return {
        kind: "document",
        fileId: raw.document.file_id,
        fileName: raw.document.file_name,
        mimeType: raw.document.mime_type,
      };
    }
    if (raw.photo && raw.photo.length > 0) {
      // Largest rendition is last.
      return { kind: "photo", fileId: raw.photo[raw.photo.length - 1].file_id, mimeType: "image/jpeg" };
    }
    if (raw.audio) {
      // file_name exists on the Telegram Audio object but is missing from older @types.
      const fileName = (raw.audio as { file_name?: string }).file_name;
      return { kind: "audio", fileId: raw.audio.file_id, fileName, mimeType: raw.audio.mime_type };
    }
    if (raw.voice) {
      return { kind: "voice", fileId: raw.voice.file_id, mimeType: raw.voice.mime_type };
    }
    if (raw.video) {
      return { kind: "video", fileId: raw.video.file_id, mimeType: raw.video.mime_type };
    }
    return undefined;
  }
}
