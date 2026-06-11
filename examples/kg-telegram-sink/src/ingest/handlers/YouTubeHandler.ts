import { YoutubeTranscript } from "youtube-transcript";
import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";
import { isYouTubeVideo } from "../../util/url";

interface OEmbed {
  title?: string;
  author_name?: string;
}

async function fetchOEmbed(url: string): Promise<OEmbed> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
    );
    if (!res.ok) return {};
    return (await res.json()) as OEmbed;
  } catch {
    return {};
  }
}

/**
 * YouTube video → caption transcript (+ title/author). When captions are absent
 * (disabled or none), falls back to title/author metadata and tells the user.
 */
export class YouTubeHandler implements SourceHandler {
  readonly name = "youtube";

  canHandle(msg: NormalizedMessage): boolean {
    return msg.urls.some(isYouTubeVideo);
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];
    for (const url of msg.urls.filter(isYouTubeVideo)) {
      const meta = await fetchOEmbed(url);
      const title = meta.title || url;
      const byline = meta.author_name ? `Video by ${meta.author_name}.` : "";

      let transcript = "";
      try {
        const segs = await YoutubeTranscript.fetchTranscript(url);
        transcript = segs.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
      } catch (err) {
        ctx.log(`youtube transcript unavailable for ${url}: ${err}`);
      }

      if (transcript) {
        const body = [byline, `Source: ${url}`, "", "Transcript:", transcript]
          .filter(Boolean)
          .join("\n");
        const path = writeMarkdown(ctx.inboxDir, { kind: "youtube", title, source: url }, body, title);
        items.push({ path, kind: "youtube", title });
      } else {
        const body = [byline, `Source: ${url}`, "", "(No transcript/captions available for this video.)"]
          .filter(Boolean)
          .join("\n");
        const path = writeMarkdown(ctx.inboxDir, { kind: "youtube", title, source: url }, body, title);
        items.push({
          path,
          kind: "youtube",
          title,
          note: "no captions found — saved title/author only",
        });
      }
    }
    return items;
  }
}
