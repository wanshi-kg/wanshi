import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";
import { writeMarkdown } from "../inboxWriter";

/**
 * STUB. Generic / Telegram-native video uploads.
 *
 * TODO: kg-gen has no video reader. The real path is ffmpeg audio-extract →
 * whisper (kg-gen's AudioReader already does whisper for audio files), then drop
 * the resulting transcript into the inbox. For now we record that a video was
 * received so it's visible in the graph and the user knows it wasn't transcribed.
 */
export class VideoHandler implements SourceHandler {
  readonly name = "video";

  canHandle(msg: NormalizedMessage): boolean {
    return msg.attachment?.kind === "video";
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const caption = msg.text?.trim();
    const title = caption?.split("\n")[0].slice(0, 60) || "Video upload";
    const body = [
      "A video was shared.",
      caption ? `Caption: ${caption}` : "",
      "(Transcription not yet implemented — needs ffmpeg + whisper.)",
    ]
      .filter(Boolean)
      .join("\n");
    const path = writeMarkdown(ctx.inboxDir, { kind: "video", title, source: "telegram-video" }, body, title);
    return [{ path, kind: "video", title, note: "video: transcription not implemented yet (saved caption only)" }];
  }
}
