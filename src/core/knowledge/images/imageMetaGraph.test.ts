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
