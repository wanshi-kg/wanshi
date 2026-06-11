import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Canonicalizer } from "./Canonicalizer";
import { TransformContext } from "../../pipeline/PipelineRunner";
import { parseConfig } from "../../../config";
import { IEmbeddingProvider } from "../../../types/IEmbeddingProvider";
import { KnowledgeGraph, Entity } from "../../../types";

/** Fake embeddings: each string maps to a 2D unit vector by angle (deg), so
 *  cosine similarity is fully controlled — synonyms share an angle, distinct
 *  terms sit far apart. No Ollama needed. */
function angleEmbeddings(angle: Record<string, number>): IEmbeddingProvider {
  const v = (s: string): number[] => {
    const r = ((angle[s] ?? 0) * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r)];
  };
  return {
    embed: async (t) => v(t),
    embedBatch: async (ts) => ts.map(v),
    clearCache() {},
    getCacheSize() {
      return 0;
    },
  };
}

const ANGLES: Record<string, number> = {
  // entity names
  LLM: 0,
  "large language model": 3, // ≈ LLM (cos 3° ≈ 0.998) → merge
  "Qwen3-0.6B": 90,
  "Qwen3-1.7B": 150, // cos(60°)=0.5 vs 0.6B → stay distinct (over-merge guard)
  system: 250,
  // relation predicates
  is_part_of: 200,
  "part of": 202,
  partOf: 201, // the three part-of variants cluster
  uses: 20,
};

function entity(name: string, observations: string[] = []): Entity {
  return {
    name,
    entityType: "concept",
    files: ["f.ts"],
    observations: observations.map((text) => ({ text })),
  };
}

const graph: KnowledgeGraph = {
  entities: [
    entity("LLM", ["a", "b"]), // more observations → canonical of its cluster
    entity("large language model", ["c"]),
    entity("Qwen3-0.6B"),
    entity("Qwen3-1.7B"),
    entity("system"),
  ],
  relations: [
    { from: "LLM", to: "system", relationType: ["is_part_of"] },
    { from: "large language model", to: "system", relationType: ["part of"] },
    { from: "Qwen3-0.6B", to: "system", relationType: ["uses"] },
    { from: "Qwen3-1.7B", to: "system", relationType: ["partOf"] },
  ],
};

function ctx(overrides: any): TransformContext {
  return {
    options: parseConfig({
      pipeline: { canonicalization: { enabled: true } },
      eval: { pinVersions: false },
      ...overrides,
    }),
    embeddings: angleEmbeddings(ANGLES),
    llm: {} as any,
    logger: { info() {}, debug() {}, warn() {}, error() {} } as any,
  };
}

describe("Canonicalizer (embeddings)", () => {
  it("collapses synonyms, keeps distinct model sizes, and dedups parallel edges", async () => {
    const out = await new Canonicalizer().apply(graph, ctx({}));
    const names = out.entities.map((e) => e.name).sort();

    // "large language model" folded into "LLM"; both Qwen sizes survive.
    expect(names).toEqual(["LLM", "Qwen3-0.6B", "Qwen3-1.7B", "system"]);
    expect(names).not.toContain("large language model");

    // The two LLM→system edges (is_part_of / part of → is_part_of) collapse to one.
    const llmEdges = out.relations.filter((r) => r.from === "LLM" && r.to === "system");
    expect(llmEdges).toHaveLength(1);
    expect(llmEdges[0].relationType).toEqual(["is_part_of"]);

    // partOf canonicalized too: Qwen3-1.7B→system carries is_part_of, not partOf.
    const qwen = out.relations.find((r) => r.from === "Qwen3-1.7B");
    expect(qwen?.relationType).toEqual(["is_part_of"]);

    // 4 raw edges → 3 (one parallel pair removed).
    expect(out.relations).toHaveLength(3);
  });

  it("writes the per-cluster merge log (the deliverable)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-"));
    const logPath = path.join(dir, "merges.jsonl");
    await new Canonicalizer().apply(
      graph,
      ctx({ inspection: { emitMergeLog: true, mergeLogPath: logPath } })
    );

    const records = fs
      .readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const entityRec = records.find((r) => r.target === "entity");
    expect(entityRec.surface_forms.sort()).toEqual(["LLM", "large language model"]);
    expect(entityRec.canonical_chosen).toBe("LLM");
    expect(entityRec.member_count).toBe(2);

    const relRec = records.find((r) => r.target === "relation");
    expect(relRec.surface_forms.sort()).toEqual(["is_part_of", "part of", "partOf"]);
    expect(relRec.canonical_chosen).toBe("is_part_of");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
