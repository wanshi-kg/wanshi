import { Logger } from "../../../../shared";

/**
 * Deterministic image-metadata extraction (the "deterministic-before-interpretive"
 * tier of the image/OCR brief). These helpers read structured facts an image
 * already carries — EXIF tags, C2PA content credentials — and return plain
 * objects that `ImageReader` stashes on `FileReadResult.metadata`; a pure builder
 * (`buildImageMetaGraph`) later turns them into graph facts that AUGMENT the VLM's
 * read (not replace it). Each helper is best-effort and never throws.
 */

/** EXIF facts we map to the graph (a deterministic subset of the tags). */
export interface ExifMetadata {
  /** Decimal GPS, computed by exifr from the GPS IFD. */
  gps?: { lat: number; lng: number };
  /** Capture time (ISO-8601) — becomes the observation/edge `validAt`. */
  dateTaken?: string;
  camera?: { make?: string; model?: string };
  author?: string;
  software?: string;
}

/**
 * Read EXIF metadata from an image via `exifr` (pure-JS). Returns `undefined`
 * when the image has no usable EXIF (e.g. a PNG screenshot) or on any parse
 * error — extraction is an enhancement, never a failure mode. Lazy-imports
 * `exifr` so a run that never touches an image pays nothing.
 */
export async function readExif(filePath: string, logger?: Logger): Promise<ExifMetadata | undefined> {
  try {
    const exifr: any = await import("exifr");
    const parse = exifr.parse ?? exifr.default?.parse;
    // Block selectors: tiff (IFD0: Make/Model/Artist/Software) + exif (DateTimeOriginal)
    // + gps (so exifr computes decimal latitude/longitude).
    const o: any = await parse(filePath, { tiff: true, exif: true, gps: true });
    if (!o) return undefined;

    const meta: ExifMetadata = {};
    if (typeof o.latitude === "number" && typeof o.longitude === "number") {
      meta.gps = { lat: o.latitude, lng: o.longitude };
    }
    const dt = o.DateTimeOriginal ?? o.CreateDate ?? o.ModifyDate;
    if (dt) meta.dateTaken = dt instanceof Date ? dt.toISOString() : String(dt);
    const make = typeof o.Make === "string" ? o.Make.trim() : undefined;
    const model = typeof o.Model === "string" ? o.Model.trim() : undefined;
    if (make || model) meta.camera = { ...(make ? { make } : {}), ...(model ? { model } : {}) };
    if (typeof o.Artist === "string" && o.Artist.trim()) meta.author = o.Artist.trim();
    if (typeof o.Software === "string" && o.Software.trim()) meta.software = o.Software.trim();

    return Object.keys(meta).length ? meta : undefined;
  } catch (e) {
    logger?.debug(`EXIF read failed for ${filePath}: ${e}`);
    return undefined;
  }
}
