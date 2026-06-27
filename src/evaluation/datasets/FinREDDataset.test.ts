import * as path from "path";
import { FinREDDataset, parseFinredOutput } from "./FinREDDataset";

const FIX = path.join(__dirname, "__fixtures__", "finred", "sample.jsonl"); // 3 rows; last has empty output

describe("FinREDDataset", () => {
  it("parses the output clause string into typed triples", () => {
    expect(parseFinredOutput("owned_by: VH1, Viacom")).toEqual([
      { subject: "VH1", predicate: "owned_by", object: "Viacom" },
    ]);
    // multiple clauses; predicate lowercased
    expect(parseFinredOutput("Founded_By: A, B; OWNED_BY: A, C")).toEqual([
      { subject: "A", predicate: "founded_by", object: "B" },
      { subject: "A", predicate: "owned_by", object: "C" },
    ]);
    // a comma inside the object is folded back, not split into a third component
    expect(parseFinredOutput("headquarters_location: ACME, Cupertino, California")).toEqual([
      { subject: "ACME", predicate: "headquarters_location", object: "Cupertino, California" },
    ]);
    expect(parseFinredOutput("")).toEqual([]);
  });

  it("loads sentence samples and skips rows with no relations", async () => {
    const samples = await new FinREDDataset().load(FIX, 100);
    expect(samples).toHaveLength(2); // the empty-output row is dropped
    expect(samples[0].groundTruth).toEqual([
      { subject: "Apple Inc", predicate: "founded_by", object: "Steve Jobs" },
      { subject: "Apple Inc", predicate: "chief_executive_officer", object: "Steve Jobs" },
    ]);
  });

  it("respects a finite limit", async () => {
    const samples = await new FinREDDataset().load(FIX, 1);
    expect(samples).toHaveLength(1);
    expect(samples[0].text).toContain("Apple Inc");
  });
});
