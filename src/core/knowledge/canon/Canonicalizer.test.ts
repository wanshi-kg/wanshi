import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Canonicalizer } from "./Canonicalizer";
import { TransformContext } from "../../pipeline/PipelineRunner";
import { parseConfig } from "../../../config";
import { IEmbeddingProvider } from "../../../types/IEmbeddingProvider";
import { KnowledgeGraph, Entity } from "../../../types";
import { trace } from "../../trace";
import { TraceRecord } from "../../trace/events";

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

  it("default complete-linkage keeps a sibling family distinct; single-linkage fuses it (KG-12)", async () => {
    // Cooc—Epicure-Cooc—Chem—Epicure-Chem—Core: a single-linkage chain at threshold 0.82.
    const sibAngles = { Cooc: 0, "Epicure-Cooc": 20, Chem: 40, "Epicure-Chem": 60, Core: 80 };
    const sibGraph: KnowledgeGraph = {
      entities: Object.keys(sibAngles).map((n) => entity(n)),
      relations: [],
    };
    const sibCtx = (linkage: "single" | "complete"): TransformContext => ({
      options: parseConfig({
        pipeline: {
          canonicalization: {
            enabled: true,
            target: ["entities"],
            embeddings: { entity: { threshold: 0.82, linkage } },
          },
        },
        eval: { pinVersions: false },
      }),
      embeddings: angleEmbeddings(sibAngles),
      llm: {} as any,
      logger: { info() {}, debug() {}, warn() {}, error() {} } as any,
    });

    const survivingSiblings = (g: KnowledgeGraph) =>
      ["Cooc", "Chem", "Core"].filter((s) => g.entities.some((e) => e.name === s));

    // complete (the default): the three distinct models survive as three entities
    const complete = await new Canonicalizer().apply(sibGraph, sibCtx("complete"));
    expect(survivingSiblings(complete)).toEqual(["Cooc", "Chem", "Core"]);

    // single: the chain collapses them (the over-merge this phase fixes)
    const single = await new Canonicalizer().apply(sibGraph, sibCtx("single"));
    expect(survivingSiblings(single).length).toBeLessThan(3);
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

// WS-12: canon runs after the merger with its own clustering/renaming and never
// folded the surface forms it collapses into the lineage thread, so
// mentionsFor(canonical) under-attributed every canon fusion. The fix routes
// each non-canonical member through trace.lineage.fold + a merge_decision emit.
describe("Canonicalizer — trace lineage fold (WS-12)", () => {
  let tmp: string;
  let out: string;

  /** Register one pre-merge mention for a name (mirrors KnowledgeGraphBuilder). */
  const registerMention = (extractionId: string, name: string) =>
    trace.lineage.registerEntity({
      mentionId: `${extractionId}|e|${name}`,
      name,
      entityType: "concept",
      chunkId: `${extractionId}:c1`,
      extractionId,
      observationIds: [],
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "canon-trace-"));
    out = path.join(tmp, "g.json.trace.jsonl");
    trace.reset();
  });
  afterEach(() => {
    trace.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("folds a collapsed surface form's mentions onto the canonical node", async () => {
    trace.configure({ enabled: true, path: out, runId: "run-canon" });
    // "LLM" and "large language model" each have a distinct pre-merge mention.
    registerMention("ext1", "LLM");
    registerMention("ext2", "large language model");

    // Before canon: each name owns exactly its own mention.
    expect(trace.lineage.mentionsFor("LLM")).toHaveLength(1);
    expect(trace.lineage.mentionsFor("large language model")).toHaveLength(1);

    await new Canonicalizer().apply(graph, ctx({}));

    // After canon: the collapsed member's mention is reattributed to "LLM",
    // and the loser name no longer owns any mentions.
    const llmMentions = trace.lineage.mentionsFor("LLM");
    expect(llmMentions.map((m) => m.mentionId).sort()).toEqual([
      "ext1|e|LLM",
      "ext2|e|large language model",
    ]);
    expect(trace.lineage.mentionsFor("large language model")).toHaveLength(0);
  });

  it("emits a merge_decision carrying the folded mention IDs", async () => {
    trace.configure({ enabled: true, path: out, runId: "run-canon" });
    registerMention("ext1", "LLM");
    registerMention("ext2", "large language model");

    await new Canonicalizer().apply(graph, ctx({}));

    const recs: TraceRecord[] = fs
      .readFileSync(out, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const decisions = recs.filter((r) => r.type === "merge_decision") as any[];

    const entityDecision = decisions.find(
      (d) => d.target === "entity" && d.canonical === "LLM"
    );
    expect(entityDecision).toBeDefined();
    expect(entityDecision.verdict).toBe("accept");
    expect(entityDecision.surfaceForms.sort()).toEqual(["LLM", "large language model"]);
    expect(entityDecision.foldedMentionIds).toContain("ext2|e|large language model");
    // The canonical's own mention is NOT in the folded list (it didn't move).
    expect(entityDecision.foldedMentionIds).not.toContain("ext1|e|LLM");
  });

  it("is observe-only: the canonicalized graph is byte-identical trace ON vs OFF", async () => {
    // OFF
    const off = await new Canonicalizer().apply(graph, ctx({}));
    expect(fs.existsSync(out)).toBe(false);

    // ON
    trace.configure({ enabled: true, path: out, runId: "run-canon" });
    registerMention("ext1", "LLM");
    registerMention("ext2", "large language model");
    const on = await new Canonicalizer().apply(graph, ctx({}));

    expect(on).toEqual(off); // lineage lives outside the graph → no observer effect
    expect(fs.existsSync(out)).toBe(true);
  });
});
