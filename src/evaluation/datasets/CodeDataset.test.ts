import * as path from "path";
import { CodeDataset } from "./CodeDataset";

const FIX = path.join(__dirname, "__fixtures__", "code"); // gold.jsonl (a.py, b.py) + src/

describe("CodeDataset", () => {
  it("loads one sample per source file, with file source as text", async () => {
    const samples = await new CodeDataset().load(FIX, 100);
    expect(samples.map((s) => s.id)).toEqual(["a.py", "b.py"]);
    expect(samples[0].text).toContain("def f():"); // real source, not the gold record
    expect(samples.every((s) => s.domain === "code")).toBe(true);
  });

  it("spreads across files under a finite limit (does not collapse to file 1)", async () => {
    const one = await new CodeDataset().load(FIX, 1);
    expect(one.map((s) => s.id)).toEqual(["a.py"]);
    const two = await new CodeDataset().load(FIX, 2);
    expect(two.map((s) => s.id)).toEqual(["a.py", "b.py"]);
  });

  it("carries the gold calls/depends_on triples through verbatim", async () => {
    const samples = await new CodeDataset().load(FIX, 100);
    const byId = new Map(samples.map((s) => [s.id, s.groundTruth]));
    expect(byId.get("a.py")).toEqual([{ subject: "f", predicate: "calls", object: "g" }]);
    expect(byId.get("b.py")).toEqual([{ subject: "b.py", predicate: "depends_on", object: "os" }]);
    for (const t of samples.flatMap((s) => s.groundTruth)) {
      expect(["calls", "depends_on"]).toContain(t.predicate);
    }
  });
});
