import { buildImageMetaGraph } from "./imageMetaGraph";
import { ProcessedFile } from "../../../types";

const pf = (exif: any): ProcessedFile =>
  ({ path: "/corpus/photos/img.jpg", chunks: [], metadata: exif ? { exif } : {} }) as unknown as ProcessedFile;

describe("buildImageMetaGraph (EXIF)", () => {
  it("maps GPS → location entity + taken_at edge with bitemporal validAt", () => {
    const g = buildImageMetaGraph(
      pf({ gps: { lat: 50.4501, lng: 30.5234 }, dateTaken: "2026-06-19T10:00:00.000Z" }),
      "/corpus"
    )!;
    expect(g).not.toBeNull();
    const image = g.entities.find((e) => e.name === "photos/img.jpg");
    expect(image?.entityType).toBe("image");
    const loc = g.entities.find((e) => e.entityType === "location");
    expect(loc).toBeDefined();
    const edge = g.relations.find((r) => r.relationType[0] === "taken_at");
    expect(edge?.from).toBe("photos/img.jpg");
    expect(edge?.to).toBe(loc!.name);
    expect(edge?.validAt).toBe("2026-06-19T10:00:00.000Z");
    expect(loc!.observations.every((o) => o.sourceAdapter === "exif" && o.confidence === 0.9)).toBe(true);
  });

  it("maps camera → device entity + captured_with edge, and author/software → image observations", () => {
    const g = buildImageMetaGraph(
      pf({ camera: { make: "Canon", model: "EOS R5" }, author: "A. Sabaka", software: "darktable 4.6" }),
      "/corpus"
    )!;
    const cam = g.entities.find((e) => e.entityType === "camera");
    expect(cam?.name).toBe("Canon EOS R5");
    expect(g.relations.some((r) => r.relationType[0] === "captured_with" && r.to === "Canon EOS R5")).toBe(true);
    const image = g.entities.find((e) => e.name === "photos/img.jpg")!;
    const texts = image.observations.map((o) => o.text);
    expect(texts.some((t) => t.includes("A. Sabaka"))).toBe(true);
    expect(texts.some((t) => t.includes("darktable 4.6"))).toBe(true);
    expect(image.observations.every((o) => o.sourceAdapter === "exif")).toBe(true);
  });

  it("returns null when the file carries no EXIF metadata", () => {
    expect(buildImageMetaGraph(pf(undefined), "/corpus")).toBeNull();
    expect(buildImageMetaGraph(pf({}), "/corpus")).toBeNull();
  });
});

describe("buildImageMetaGraph (C2PA)", () => {
  const pfMeta = (metadata: any): ProcessedFile =>
    ({ path: "/corpus/photos/img.jpg", chunks: [], metadata }) as unknown as ProcessedFile;
  const image = (g: any) => g.entities.find((e: any) => e.name === "photos/img.jpg");

  it("records a valid credential as a non-verdict trust observation on the image", () => {
    const g = buildImageMetaGraph(pfMeta({ c2pa: { present: true, valid: true, signer: "Truepic", aiGenerated: true } }), "/corpus")!;
    const o = image(g).observations.find((x: any) => x.sourceAdapter === "c2pa")!;
    expect(o.confidence).toBe(0.95);
    expect(o.text).toContain("present and valid");
    expect(o.text).toContain("Truepic");
    expect(o.text).toContain("AI-generated");
    expect(o.text).toContain("not truth"); // the mandatory hedge
  });

  it("records absence as a fact, not a verdict", () => {
    const g = buildImageMetaGraph(pfMeta({ c2pa: { present: false } }), "/corpus")!;
    const o = image(g).observations.find((x: any) => x.sourceAdapter === "c2pa")!;
    expect(o.text).toContain("No C2PA Content Credential found");
    expect(o.text).toContain("not evidence");
  });

  it("emits nothing when provenance could not be read (unavailable)", () => {
    expect(buildImageMetaGraph(pfMeta({ c2pa: { present: false, unavailable: true } }), "/corpus")).toBeNull();
  });

  it("combines with EXIF on the same image node", () => {
    const g = buildImageMetaGraph(
      pfMeta({ exif: { camera: { make: "Sony", model: "A7" } }, c2pa: { present: true, valid: true } }),
      "/corpus"
    )!;
    const adapters = new Set(image(g).observations.map((o: any) => o.sourceAdapter));
    expect(adapters.has("c2pa")).toBe(true);
    expect(g.entities.some((e) => e.entityType === "camera")).toBe(true);
  });
});

describe("buildImageMetaGraph (CV detection)", () => {
  const box = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };
  const pfMeta = (metadata: any): ProcessedFile =>
    ({ path: "/corpus/photos/img.jpg", chunks: [], metadata }) as unknown as ProcessedFile;
  const image = (g: any) => g.entities.find((e: any) => e.name === "photos/img.jpg");

  it("maps detections → object entities + depicts edges + cv-detection observations (score = confidence)", () => {
    const g = buildImageMetaGraph(
      pfMeta({
        cvDetection: {
          objects: [
            { label: "person", score: 0.95, box },
            { label: "person", score: 0.8, box },
            { label: "car", score: 0.7, box },
          ],
        },
      }),
      "/corpus"
    )!;
    const person = g.entities.find((e) => e.name === "person")!;
    expect(person.entityType).toBe("object");
    expect(person.observations[0].sourceAdapter).toBe("cv-detection");
    expect(person.observations[0].confidence).toBe(0.95); // top score for the label
    expect(g.relations.some((r) => r.relationType[0] === "depicts" && r.to === "person")).toBe(true);
    expect(g.relations.some((r) => r.relationType[0] === "depicts" && r.to === "car")).toBe(true);
    // a summary observation lands on the image node
    expect(image(g).observations.some((o: any) => o.sourceAdapter === "cv-detection" && o.text.includes("person ×2"))).toBe(true);
  });

  it("returns null when cvDetection has no objects", () => {
    expect(buildImageMetaGraph(pfMeta({ cvDetection: { objects: [] } }), "/corpus")).toBeNull();
  });
});
