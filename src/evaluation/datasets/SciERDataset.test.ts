import * as path from "path";
import { SciERDataset } from "./SciERDataset";

const FIX = path.join(__dirname, "__fixtures__", "scier", "sample.jsonl"); // D1 (2 rows), D2 (1 row)

describe("SciERDataset", () => {
  it("groups sentence rows into documents (cap is over documents, not rows)", async () => {
    const samples = await new SciERDataset().load(FIX, 100);
    expect(samples.map((s) => s.id)).toEqual(["D1", "D2"]);
    // D1's text is both of its sentences joined in order
    expect(samples[0].text).toBe("BERT is used for NER . BERT is trained with BookCorpus .");
  });

  it("respects a finite document limit", async () => {
    const samples = await new SciERDataset().load(FIX, 1);
    expect(samples.map((s) => s.id)).toEqual(["D1"]);
  });

  it("unions + deduplicates a document's per-sentence rels, lowercasing predicates", async () => {
    const [d1] = await new SciERDataset().load(FIX, 1);
    // Used-For appears in both rows → deduped to one; predicates lowercased.
    expect(d1.groundTruth).toEqual([
      { subject: "BERT", predicate: "used-for", object: "NER" },
      { subject: "BERT", predicate: "trained-with", object: "BookCorpus" },
    ]);
    for (const t of d1.groundTruth) expect(t.predicate).toBe(t.predicate.toLowerCase());
  });
});
