import { Entity, KnowledgeGraph, Observation, ProcessedFile, Relation } from "../../../types";
import { toRelPathId } from "../../corpus/relPath";
import { ExifMetadata } from "../../processor/readers/image/imageMetadata";

/**
 * Turn an image's deterministic metadata (`metadata.exif` — and, later,
 * `metadata.c2pa`) into a `KnowledgeGraph` fragment that AUGMENTS the VLM's read
 * of the image rather than replacing it. Mirrors `buildReferenceGraph`: a pure
 * per-file module whose fragment `DirectoryProcessor` unions into the per-file
 * `graphs[]` (alongside the LLM extraction + AST seed + reference graph), so it
 * flows through merge/canon like any other fragment.
 *
 * The image file itself is an entity keyed by corpus-relative path (`toRelPathId`,
 * the buildReferenceGraph convention) and is always emitted, so EXIF/C2PA edges
 * never dangle. Facts are stamped `sourceAdapter:"exif"`/`"c2pa"` + a `confidence`
 * (read-reliability, not a truth verdict). Capture time → bitemporal `validAt`.
 */

const IMAGE = "image";
// EXIF is a deterministic read but the tags are editable/strippable, so it is
// high- but not perfect-confidence (cryptographic C2PA, added later, scores higher).
const EXIF_CONFIDENCE = 0.9;

export function buildImageMetaGraph(processedFile: ProcessedFile, inputRoot: string): KnowledgeGraph | null {
  const exif = processedFile.metadata?.exif as ExifMetadata | undefined;
  if (!exif) return null;

  const imageName = toRelPathId(inputRoot, processedFile.path);
  const createdAt = new Date().toISOString();
  const entities = new Map<string, Entity>();
  const relations: Relation[] = [];

  const ensure = (name: string, entityType: string, observations: Observation[] = []): Entity => {
    const existing = entities.get(name);
    if (existing) {
      if (observations.length) existing.observations.push(...observations);
      return existing;
    }
    const e: Entity = { name, entityType, files: [], observations };
    entities.set(name, e);
    return e;
  };
  const exifObs = (text: string, extra: Partial<Observation> = {}): Observation => ({
    text,
    source: processedFile.path,
    createdAt,
    sourceAdapter: "exif",
    confidence: EXIF_CONFIDENCE,
    ...extra,
  });
  const edge = (to: string, type: string, validAt?: string) => {
    if (!to || to === imageName) return; // no self-loops
    relations.push({ from: imageName, to, relationType: [type], source: imageName, ...(validAt ? { validAt } : {}) });
  };

  // The image file as an entity (edge endpoint + holder of attribute observations).
  const image = ensure(imageName, IMAGE);
  image.files.push(processedFile.path);

  const validAt = exif.dateTaken;
  if (exif.dateTaken) image.observations.push(exifObs(`Captured: ${exif.dateTaken}`, { validAt }));
  if (exif.author) image.observations.push(exifObs(`Author: ${exif.author}`));
  if (exif.software) image.observations.push(exifObs(`Software: ${exif.software}`));

  // GPS → a location entity (deterministic, deduped to ~1 m by the rounded name).
  if (exif.gps) {
    const loc = `Location(${exif.gps.lat.toFixed(5)}, ${exif.gps.lng.toFixed(5)})`;
    ensure(loc, "location", [
      exifObs(`Latitude: ${exif.gps.lat}`, { locator: "gps" }),
      exifObs(`Longitude: ${exif.gps.lng}`, { locator: "gps" }),
    ]);
    edge(loc, "taken_at", validAt);
  }

  // Camera make/model → a device entity (reused across photos from one camera).
  if (exif.camera && (exif.camera.make || exif.camera.model)) {
    const cam = [exif.camera.make, exif.camera.model].filter(Boolean).join(" ").trim();
    if (cam) {
      ensure(cam, "camera", [
        ...(exif.camera.make ? [exifObs(`Make: ${exif.camera.make}`)] : []),
        ...(exif.camera.model ? [exifObs(`Model: ${exif.camera.model}`)] : []),
      ]);
      edge(cam, "captured_with", validAt);
    }
  }

  const hasObservations = Array.from(entities.values()).some((e) => e.observations.length > 0);
  if (!relations.length && !hasObservations) return null;
  return { entities: Array.from(entities.values()), relations };
}
