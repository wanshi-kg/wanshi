import { ObjectDetectionService, CvDetectionOptions, DetectionPipeline } from "./ObjectDetectionService";
import { stubLogger } from "../../__tests__/helpers";

const opts = (over: Partial<CvDetectionOptions> = {}): CvDetectionOptions => ({
  mode: "closed",
  model: "",
  threshold: 0.5,
  labels: [],
  maxObjects: 20,
  allowRemote: true,
  ...over,
});
const box = { xmin: 0, ymin: 0, xmax: 1, ymax: 1 };

describe("ObjectDetectionService", () => {
  it("maps, score-sorts, threshold-filters and caps detections (closed mode)", async () => {
    const pipe = jest.fn(async () => [
      { label: "person", score: 0.9, box },
      { label: "car", score: 0.6, box },
      { label: "noise", score: 0.2, box }, // below threshold → dropped
    ]) as unknown as DetectionPipeline;
    const svc = new ObjectDetectionService(opts({ maxObjects: 2 }), stubLogger(), pipe);
    const dets = await svc.detect("/x/a.jpg");
    expect(pipe).toHaveBeenCalledWith("/x/a.jpg", { threshold: 0.5 });
    expect(dets.map((d) => d.label)).toEqual(["person", "car"]); // sorted desc, noise filtered, capped to 2
    expect(dets[0].score).toBe(0.9);
  });

  it("passes candidate labels in zero-shot mode", async () => {
    const pipe = jest.fn(async () => [{ label: "tank", score: 0.8, box }]) as unknown as DetectionPipeline;
    const svc = new ObjectDetectionService(opts({ mode: "zero-shot", labels: ["tank", "truck"] }), stubLogger(), pipe);
    const dets = await svc.detect("/x/a.jpg");
    expect(pipe).toHaveBeenCalledWith("/x/a.jpg", ["tank", "truck"], { threshold: 0.5 });
    expect(dets[0].label).toBe("tank");
  });

  it("returns [] for zero-shot with no labels (no pipeline call)", async () => {
    const pipe = jest.fn() as unknown as DetectionPipeline;
    const svc = new ObjectDetectionService(opts({ mode: "zero-shot", labels: [] }), stubLogger(), pipe);
    expect(await svc.detect("/x/a.jpg")).toEqual([]);
    expect(pipe).not.toHaveBeenCalled();
  });

  it("returns [] (no throw) when the pipeline fails", async () => {
    const pipe = jest.fn(async () => {
      throw new Error("model download failed");
    }) as unknown as DetectionPipeline;
    const svc = new ObjectDetectionService(opts(), stubLogger(), pipe);
    expect(await svc.detect("/x/a.jpg")).toEqual([]);
  });
});
