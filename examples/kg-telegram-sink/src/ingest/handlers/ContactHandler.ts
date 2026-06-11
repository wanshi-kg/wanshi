import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";

/** Shared Telegram contact → a small person record. Fully supported. */
export class ContactHandler implements SourceHandler {
  readonly name = "contact";

  canHandle(msg: NormalizedMessage): boolean {
    return !!msg.contact;
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const c = msg.contact!;
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
    const body = [
      `${name} is a person.`,
      `Phone number: ${c.phoneNumber}.`,
      c.userId ? `Telegram user id: ${c.userId}.` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const path = writeMarkdown(
      ctx.inboxDir,
      { kind: "contact", title: name, source: "telegram-contact" },
      body,
      name
    );
    return [{ path, kind: "contact", title: name }];
  }
}
