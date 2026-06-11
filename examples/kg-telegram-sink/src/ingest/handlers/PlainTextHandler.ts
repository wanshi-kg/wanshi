import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";

/**
 * Fallback handler: any message that carries text and isn't claimed by a more
 * specific handler (forwarded posts, notes, quotes) is saved verbatim.
 * Registered LAST.
 */
export class PlainTextHandler implements SourceHandler {
  readonly name = "plain-text";

  canHandle(msg: NormalizedMessage): boolean {
    return !!msg.text && msg.text.trim().length > 0;
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const text = msg.text!.trim();
    const title = text.split("\n")[0].slice(0, 60);
    const path = writeMarkdown(
      ctx.inboxDir,
      { kind: "note", title, source: "telegram" },
      text
    );
    return [{ path, kind: "note", title }];
  }
}
