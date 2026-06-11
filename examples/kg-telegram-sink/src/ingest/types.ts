/**
 * Ingest layer contracts.
 *
 * A `SourceHandler` turns one incoming Telegram message into zero or more files
 * written into the kg-gen inbox. Handlers are tried in priority order (first
 * `canHandle` wins) by `SourceRouter` — the same strategy idiom kg-gen uses for
 * its `FileReaderFactory`. Add a source = implement this interface and register
 * it in `SourceRouter`.
 */

export type AttachmentKind =
  | "document"
  | "photo"
  | "audio"
  | "voice"
  | "video";

export interface Attachment {
  kind: AttachmentKind;
  fileId: string;
  fileName?: string;
  mimeType?: string;
}

export interface ContactInfo {
  firstName: string;
  lastName?: string;
  phoneNumber: string;
  userId?: number;
}

/**
 * Provider-agnostic view of an incoming message, decoupled from the
 * node-telegram-bot-api types so handlers stay testable.
 */
export interface NormalizedMessage {
  userId: number;
  chatId: number;
  /** Message text or attachment caption, if any. */
  text?: string;
  /** http(s) URLs found in the text, in order of appearance. */
  urls: string[];
  /** Set when the message is a shared contact. */
  contact?: ContactInfo;
  /** Set when the message carries a file/media. */
  attachment?: Attachment;
}

/** Services a handler may use while ingesting. */
export interface IngestContext {
  /** Absolute path of the inbox directory kg-gen scans. */
  inboxDir: string;
  /** Download a Telegram file by id into the inbox, returning its absolute path. */
  downloadFile(fileId: string, suggestedName: string): Promise<string>;
  log: (msg: string) => void;
}

/** A single artifact written to the inbox. */
export interface IngestedItem {
  /** Absolute path of the written file. */
  path: string;
  /** Coarse source kind, e.g. "article", "youtube", "contact". */
  kind: string;
  title?: string;
  /**
   * Optional user-facing note — used by stub handlers to be honest about partial
   * capture ("saved metadata only"). Surfaced in the Telegram reply.
   */
  note?: string;
}

export interface SourceHandler {
  readonly name: string;
  canHandle(msg: NormalizedMessage): boolean;
  ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]>;
}
