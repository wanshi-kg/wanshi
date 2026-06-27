import * as fs from "fs";
import * as os from "os";
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

  // Regression: the real development split has a malformed/short relation row (missing an Arg
  // id). The loader must skip it, not crash on arg1.split (was an unguarded TypeError).
  it("skips a malformed/short relation row without crashing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drugprot-"));
    fs.writeFileSync(path.join(dir, "t_abstracs.tsv"), "100\tT\tAspirinX inhibits COXZ .\n");
    fs.writeFileSync(path.join(dir, "t_entities.tsv"), "100\tT1\tCHEMICAL\t0\t8\tAspirinX\n100\tT2\tGENE\t18\t22\tCOXZ\n");
    // one good row + one short row (3 columns → arg2 undefined → would crash before the guard)
    fs.writeFileSync(path.join(dir, "t_relations.tsv"), "100\tINHIBITOR\tArg1:T1\tArg2:T2\n100\tINHIBITOR\tArg1:T1\n");
    try {
      const samples = await new DrugProtDataset().load(dir, 100);
      expect(samples).toHaveLength(1);
      expect(samples[0].groundTruth).toEqual([{ subject: "AspirinX", predicate: "inhibitor", object: "COXZ" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
