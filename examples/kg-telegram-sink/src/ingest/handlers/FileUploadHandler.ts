import { SourceHandler, NormalizedMessage, IngestContext, IngestedItem } from "../types";

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

/**
 * Document / photo / audio / voice uploads → downloaded into the inbox as-is and
 * left for kg-gen's own readers (PdfReader, OfficeReader, ImageReader, AudioReader)
 * to handle on the next pipeline run. Generic video is NOT handled here — see
 * VideoHandler (stub).
 *
 * Note: image extraction needs an Ollama vision model and audio needs whisper —
 * both kg-gen-side. Without them those files are skipped gracefully downstream.
 */
export class FileUploadHandler implements SourceHandler {
  readonly name = "file-upload";

  canHandle(msg: NormalizedMessage): boolean {
    return !!msg.attachment && msg.attachment.kind !== "video";
  }

  async ingest(msg: NormalizedMessage, ctx: IngestContext): Promise<IngestedItem[]> {
    const att = msg.attachment!;
    const ext =
      (att.fileName && att.fileName.includes(".") ? "" : EXT_BY_MIME[att.mimeType ?? ""] ?? "") ||
      "";
    const suggested = att.fileName || `${att.kind}-${att.fileId.slice(-8)}${ext || ".bin"}`;
    const path = await ctx.downloadFile(att.fileId, suggested);
    return [
      {
        path,
        kind: att.kind,
        title: suggested,
        note:
          att.kind === "photo" || att.kind === "audio" || att.kind === "voice"
            ? `saved ${att.kind} — extraction needs the matching kg-gen reader (Ollama vision / whisper)`
            : undefined,
      },
    ];
  }
}
