import * as path from "path";
import { BioREDDataset } from "./BioREDDataset";

const FIX = path.join(__dirname, "__fixtures__", "biored", "sample.BioC.JSON"); // 2 docs, 3 relations

describe("BioREDDataset", () => {
  it("loads every document when the limit exceeds the corpus", async () => {
    const samples = await new BioREDDataset().load(FIX, 100);
    expect(samples.map((s) => s.id)).toEqual(["111", "222"]);
  });

  it("respects a finite limit (doc-level count, not relation count)", async () => {
    const samples = await new BioREDDataset().load(FIX, 1);
    expect(samples).toHaveLength(1);
    expect(samples[0].id).toBe("111");
  });

  it("resolves concept ids inside MULTI-ID annotations to a surface mention", async () => {
    // R0 references entity2 "D000002", which lives only inside the multi-id
    // annotation "D000001,D000002" → must resolve to "headache", never the raw id.
    const [doc111] = await new BioREDDataset().load(FIX, 1);
    const positive = doc111.groundTruth.find((t) => t.predicate === "positive_correlation");
    expect(positive).toEqual({
      subject: "Acetylsalicylic acid", // longest mention wins for C001
      predicate: "positive_correlation",
      object: "headache",
    });
  });

  it("produces well-formed, vocab-lowercased binary triples with no raw ids", async () => {
    const samples = await new BioREDDataset().load(FIX, 100);
    const triples = samples.flatMap((s) => s.groundTruth);
    expect(triples).toHaveLength(3);
    for (const t of triples) {
      expect(t.subject).toBeTruthy();
      expect(t.object).toBeTruthy();
      expect(t.predicate).toBe(t.predicate.toLowerCase());
      // no raw concept id leaked as a surface form (D###### / bare C###)
      expect(t.subject).not.toMatch(/^[CD]\d{3,}/);
      expect(t.object).not.toMatch(/^[CD]\d{3,}/);
    }
    expect(new Set(triples.map((t) => t.predicate))).toEqual(
      new Set(["positive_correlation", "association", "negative_correlation"]),
    );
  });
});
