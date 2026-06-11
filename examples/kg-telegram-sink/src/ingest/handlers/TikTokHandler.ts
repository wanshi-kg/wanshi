import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";
import { isTikTokVideo } from "../../util/url";

interface OEmbed {
  title?: string;
  author_name?: string;
}

/**
 * STUB (metadata-only). A TikTok video URL → oEmbed title/author + caption.
 *
 * TODO: full transcript needs downloading the video and running ASR
 * (ffmpeg audio-extract → whisper, reusing kg-gen's AudioReader path). That's a
 * self-contained follow-up; this handler intentionally captures metadata only so
 * the graph isn't empty and the user is told what was (and wasn't) captured.
 */
export class TikTokHandler implements SourceHandler {
  readonly name = "tiktok";

  canHandle(msg: NormalizedMessage): boolean {
    return msg.urls.some(isTikTokVideo);
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];
    for (const url of msg.urls.filter(isTikTokVideo)) {
      let meta: OEmbed = {};
      try {
        const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
        if (res.ok) meta = (await res.json()) as OEmbed;
      } catch (err) {
        ctx.log(`tiktok oembed failed for ${url}: ${err}`);
      }
      const title = meta.title || `TikTok video`;
      const body = [
        meta.author_name ? `Video by ${meta.author_name}.` : "",
        meta.title ? `Caption: ${meta.title}` : "",
        `Source: ${url}`,
      ]
        .filter(Boolean)
        .join("\n");
      const path = writeMarkdown(ctx.inboxDir, { kind: "tiktok", title, source: url }, body, title);
      items.push({ path, kind: "tiktok", title, note: "TikTok: saved metadata only (no transcript yet)" });
    }
    return items;
  }
}
