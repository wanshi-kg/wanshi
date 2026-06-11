import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "./types";
import { YouTubeHandler } from "./handlers/YouTubeHandler";
import { TikTokHandler } from "./handlers/TikTokHandler";
import { ChannelHandler } from "./handlers/ChannelHandler";
import { ArticleHandler } from "./handlers/ArticleHandler";
import { VideoHandler } from "./handlers/VideoHandler";
import { FileUploadHandler } from "./handlers/FileUploadHandler";
import { ContactHandler } from "./handlers/ContactHandler";
import { PlainTextHandler } from "./handlers/PlainTextHandler";

/**
 * First-match-wins registry, same idiom as kg-gen's FileReaderFactory. Order is
 * priority: most specific source kinds first, the verbatim text fallback last.
 *
 * To add a source: implement SourceHandler, import it, and slot it into this
 * array at the right priority.
 */
const DEFAULT_HANDLERS: SourceHandler[] = [
  new ChannelHandler(),    // channel URLs before single-video URLs
  new YouTubeHandler(),
  new TikTokHandler(),
  new ArticleHandler(),    // any remaining web URL
  new VideoHandler(),      // video attachments before generic file upload
  new FileUploadHandler(), // documents / photos / audio
  new ContactHandler(),
  new PlainTextHandler(),  // fallback: raw text
];

export class SourceRouter {
  constructor(private readonly handlers: SourceHandler[] = DEFAULT_HANDLERS) {}

  /** Run the first handler that claims this message. Returns its items (possibly empty). */
  async route(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const handler = this.handlers.find((h) => h.canHandle(msg));
    if (!handler) {
      ctx.log("no handler matched message");
      return [];
    }
    ctx.log(`routing to handler: ${handler.name}`);
    return handler.ingest(msg, ctx);
  }
}
