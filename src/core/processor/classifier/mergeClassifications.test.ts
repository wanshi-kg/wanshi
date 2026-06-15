import { mergeChunkClassifications } from "./mergeClassifications";
import { ClassificationResult } from "../../../types";

describe("mergeChunkClassifications (S1: prevalence weighting)", () => {
  it("ranks a pervasive class above a single-chunk spike", () => {
    // `code` present in all 10 chunks @0.8; `medical` in just 1 chunk @0.9.
    const perChunk: ClassificationResult[][] = [];
    for (let i = 0; i < 10; i++) {
      const chunk: ClassificationResult[] = [{ class: "code", confidence: 0.8 }];
      if (i === 0) chunk.push({ class: "medical", confidence: 0.9 });
      perChunk.push(chunk);
    }

    const merged = mergeChunkClassifications(perChunk);

    // Old code averaged over present chunks (medical -> 0.9, code -> 0.8) and put
    // the one-chunk spike on top. Prevalence weighting flips that.
    expect(merged[0].class).toBe("code");
    expect(merged[0].confidence).toBeCloseTo(0.8); // 8.0 / 10
    const medical = merged.find((r) => r.class === "medical");
    expect(medical?.confidence).toBeCloseTo(0.09); // 0.9 / 10
  });

  it("preserves magnitude for a unanimous class and a single-chunk file", () => {
    expect(
      mergeChunkClassifications([
        [{ class: "code", confidence: 0.8 }],
        [{ class: "code", confidence: 0.8 }],
      ])[0].confidence
    ).toBeCloseTo(0.8);

    expect(
      mergeChunkClassifications([[{ class: "code", confidence: 0.9 }]])[0]
        .confidence
    ).toBeCloseTo(0.9);
  });

  it("returns an empty ranking for no chunks", () => {
    expect(mergeChunkClassifications([])).toEqual([]);
  });
});
