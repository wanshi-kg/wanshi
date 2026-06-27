import * as path from "path";
import { DrugProtDataset } from "./DrugProtDataset";

const FIX = path.join(__dirname, "__fixtures__", "drugprot", "dev"); // 3 pmids; 300 has no relations

describe("DrugProtDataset", () => {
  it("joins the three TSVs and skips pmids with no relations", async () => {
    const samples = await new DrugProtDataset().load(FIX, 100);
    expect(samples.map((s) => s.id)).toEqual(["100", "200"]); // 300 (no relations) dropped
    expect(samples[0].text).toBe("Aspirin study Aspirin inhibits COX2 .");
  });

  it("resolves Arg term-ids to entity surfaces (not raw T#)", async () => {
    const [doc100] = await new DrugProtDataset().load(FIX, 1);
    expect(doc100.groundTruth).toEqual([{ subject: "Aspirin", predicate: "inhibitor", object: "COX2" }]);
    for (const t of doc100.groundTruth) {
      expect(t.subject).not.toMatch(/^T\d+$/);
      expect(t.object).not.toMatch(/^T\d+$/);
      expect(t.predicate).toBe(t.predicate.toLowerCase());
    }
  });

  it("respects a finite document limit", async () => {
    const samples = await new DrugProtDataset().load(FIX, 1);
    expect(samples.map((s) => s.id)).toEqual(["100"]);
  });
});
