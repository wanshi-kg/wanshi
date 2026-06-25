import * as path from "path";
import { RedocredDataset } from "./RedocredDataset";

// 4-doc array: Alpha(0, valid) · Empty(1, no labels → skipped) · Beta(2, valid) · Gamma(3, valid)
const FIX = path.join(__dirname, "__fixtures__", "redocred", "sample.json");

// RE-DocRED is a SINGLE-FILE loader (one JSON array of documents). It is NOT
// vulnerable to the WS-01 bug class (a per-file budget compared against a
// cumulative count across MULTIPLE files), because there is no sub-loader loop —
// `samples.length < limit` over one array is the correct first-N semantic. These
// tests pin that semantic so a future "optimization" can't silently truncate.
describe("RedocredDataset", () => {
  it("loads the first N valid documents in file order under a finite limit", async () => {
    const samples = await new RedocredDataset().load(FIX, 2);
    expect(samples).toHaveLength(2);
    // Document order preserved; the empty-labels doc between them is skipped, and
    // skipping it does NOT consume limit budget (else we'd get only Alpha).
    expect(samples[0].id).toMatch(/^Alpha_Doc/);
    expect(samples[1].id).toMatch(/^Beta_Doc/);
    expect(samples.some((s) => /Empty/.test(s.id))).toBe(false);
  });

  it("returns every valid document when the limit exceeds the corpus (Empty skipped)", async () => {
    const samples = await new RedocredDataset().load(FIX, 100);
    expect(samples).toHaveLength(3); // Alpha, Beta, Gamma — Empty (no labels) dropped
    expect(samples.map((s) => s.id.replace(/_\d+$/, ""))).toEqual(["Alpha_Doc", "Beta_Doc", "Gamma_Doc"]);
  });

  it("maps Wikidata property IDs to readable predicates in the ground truth", async () => {
    const [alpha] = await new RedocredDataset().load(FIX, 1);
    expect(alpha.groundTruth).toEqual([
      { subject: "Alpha", predicate: "publication date", object: "2020" }, // P577
    ]);
  });
});
