import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";
import { isYouTubeChannel, isTikTokChannel } from "../../util/url";

/**
 * STUB. YouTube / TikTok CHANNEL URLs (a subscription, not a single item).
 *
 * TODO: real channel subscription is a background-job subsystem — poll the
 * channel feed (RSS for YouTube; scrape/API for TikTok) on a schedule and ingest
 * each new upload through the YouTube/TikTok handlers. That's a separate feature
 * (persistent subscription store + scheduler), so here we just record the channel
 * itself and tell the user it isn't being followed yet.
 */
export class ChannelHandler implements SourceHandler {
  readonly name = "channel";

  canHandle(msg: NormalizedMessage): boolean {
    return msg.urls.some((u) => isYouTubeChannel(u) || isTikTokChannel(u));
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];
    for (const url of msg.urls.filter((u) => isYouTubeChannel(u) || isTikTokChannel(u))) {
      const body = [`A content channel: ${url}`, "(Subscription/auto-follow not yet implemented.)"].join("\n");
      const path = writeMarkdown(ctx.inboxDir, { kind: "channel", title: url, source: url }, body, url);
      items.push({
        path,
        kind: "channel",
        title: url,
        note: "channel saved, but auto-following new uploads isn't implemented yet",
      });
    }
    return items;
  }
}
