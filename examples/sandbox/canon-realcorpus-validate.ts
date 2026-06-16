/**
 * REAL-CORPUS adjudicator validation — the merge gate for the softened canon guidance.
 *
 * The bake-off (canon-escalation-spike.ts) ran on 12 hand-curated pairs. Dove's audit: that's a
 * coin-flip denominator, and the trace's standalone-value gate was never ratified on real data.
 * This harness closes both: it drives the REAL production `Canonicalizer` over real extracted
 * graphs (kggt5-self 685 ent · telegram 738 ent) with `trace.enabled`, then analyzes the
 * adjudicator's decisions OFF the emitted `merge_decision` trace events (ratifying the trace).
 *
 * It sweeps guidance {baseline = old "Be conservative" · default = the shipped softened+few-shot,
 * read from the schema} × model {gemma3:4b-cloud = README-default SMALL/deployment target ·
 * gemma4:31b-cloud = capable}. Both arms cloud (spares the M4). The headline questions:
 *   (recall)    does the softened default merge MORE true aliases on a real corpus, not just 12?
 *   (precision) does the SMALL model accept hypernym/containment pairs under the softened default?
 *               — Dove's flag: "accept containment" conflates alias-containment (Cooc≡Epicure-Cooc)
 *               with hypernym-containment (Epicure⊃Epicure-Core); the small model may not disambiguate.
 *
 * Run:  npx ts-node examples/sandbox/canon-realcorpus-validate.ts
 */
import * as fs from "fs";
import * as path from "path";
import { Ollama } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { parseJsonLenient } from "../../src/shared/utils";
import { Canonicalizer } from "../../src/core/knowledge/canon/Canonicalizer";
import { TransformContext } from "../../src/core/pipeline/PipelineRunner";
import { parseConfig } from "../../src/config";
import { trace } from "../../src/core/trace";
import { KnowledgeGraph, Entity } from "../../src/types";
import { ILLMProvider } from "../../src/types/ILLMProvider";
import { IEmbeddingProvider } from "../../src/types/IEmbeddingProvider";

// ── config ─────────────────────────────────────────────────────────────────────
const EMB_MODEL = "mxbai-embed-large:335m";
const SMALL_MODEL = "gemma3:4b-cloud"; // README-default small model = the deployment target
const CAPABLE_MODEL = "gemma4:31b-cloud"; // the model that held precision in the bake-off
const BLOCK_TOP_N = 10; // each entity's 10 nearest are merge-eligible (production-style blocking)
const MAX_ADJ = 300; // adjudication cap per pass (the experiment's budget)
const OUT_DIR = "examples/sandbox/canon-realcorpus";

const OLD_GUIDANCE =
  "You decide whether two surface forms refer to the SAME thing. " +
  "Answer only by setting `merge` true (same) or false (distinct). " +
  "Be conservative: distinct versions/models/sizes are NOT the same.";
// The shipped default — read from the schema so we validate EXACTLY what merges, not a copy.
const NEW_GUIDANCE = parseConfig({}).pipeline.canonicalization.llm.guidance;

const GRAPHS = [
  { name: "self-code", path: "kg_tests/self/kggt5-knowledge-graph.mcp-jsonl", arms: "full" },
  // telegram: small-model precision check only (the containment-hypernym regime that raised the flag)
  { name: "telegram-prose", path: "examples/kg-telegram-sink/data/output/graph.mcp-jsonl", arms: "small-only" },
] as const;

// ── mcp-jsonl loader → KnowledgeGraph ────────────────────────────────────────────
function loadGraph(p: string): KnowledgeGraph {
  const entities: Entity[] = [];
  const relations: KnowledgeGraph["relations"] = [];
  for (const line of fs.readFileSync(p, "utf8").trim().split("\n")) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "entity" && typeof o.name === "string") {
      entities.push({
        name: o.name,
        entityType: o.entityType ?? "concept",
        files: [],
        observations: (o.observations ?? []).map((t: any) => ({ text: String(t) })),
      });
    } else if (o?.type === "relation" && o.from && o.to) {
      relations.push({ from: o.from, to: o.to, relationType: [].concat(o.relationType ?? "related_to") });
    }
  }
  return { entities, relations };
}

// ── robust verdict parser (gemma3:4b ignores json_schema → bare "True\n"; qwen emits <think>) ──
function stripFence(c: string): string {
  if (c.startsWith("```")) return c.slice(c.indexOf("\n") + 1, c.lastIndexOf("\n"));
  return c;
}
function parseMerge(raw: string): boolean | null {
  let c = raw.trim().replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  c = stripFence(c).trim();
  try {
    const o = parseJsonLenient(c) as any;
    if (o && typeof o.merge === "boolean") return o.merge;
  } catch { /* fall through */ }
  let m = c.match(/merge["']?\s*[:=]\s*(true|false)/i);
  if (m) return m[1].toLowerCase() === "true";
  m = c.match(/^\s*(true|false|yes|no|same|distinct|different)\b/i);
  if (m) { const w = m[1].toLowerCase(); return w === "true" || w === "yes" || w === "same"; }
  return null;
}

const ollama = new Ollama();

// ── shared, cached embeddings (compute each name's vector once across all passes) ──
const embCache = new Map<string, number[]>();
const embeddings: IEmbeddingProvider = {
  async embed(t: string): Promise<number[]> {
    const key = t.slice(0, 1024);
    if (!embCache.has(key)) {
      const r = await ollama.embeddings({ model: EMB_MODEL, prompt: key });
      embCache.set(key, r.embedding);
    }
    return embCache.get(key)!;
  },
  async embedBatch(ts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < ts.length; i++) {
      out.push(await this.embed(ts[i]));
      if ((i + 1) % 200 === 0) process.stdout.write(`    …embed ${i + 1}/${ts.length}\r`);
    }
    return out;
  },
  clearCache() {},
  getCacheSize() { return embCache.size; },
};

// ── Ollama adjudicator as ILLMProvider (the guidance arrives via cfg.llm.guidance → system msg) ──
let parseFailures = 0;
function makeLlm(model: string): ILLMProvider {
  return {
    async generateStructured<T>(messages: any[], schema: z.ZodType<T>): Promise<T> {
      const res = await ollama.chat({
        model,
        messages,
        format: zodToJsonSchema(schema) as any,
        think: false,
        options: { temperature: 0.1 },
      });
      const v = parseMerge(res.message.content);
      if (v === null) { parseFailures++; return { merge: false } as any; } // on-error = reject (prod behavior)
      return { merge: v } as any;
    },
    async getModelCapabilities() { return []; },
  };
}

const silentLogger = { info() {}, debug() {}, warn() {}, error() {} } as any;

interface Decision { pair: [string, string]; verdict: boolean; }
function readDecisions(tracePath: string): Decision[] {
  if (!fs.existsSync(tracePath)) return [];
  const out: Decision[] = [];
  for (const line of fs.readFileSync(tracePath, "utf8").trim().split("\n")) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "merge_decision" && o.target === "entity" && Array.isArray(o.surfaceForms)) {
      const [a, b] = o.surfaceForms;
      out.push({ pair: [a, b], verdict: o.verdict === "accept" });
    }
  }
  return out;
}
const pairKey = ([a, b]: [string, string]) => (a < b ? `${a}␟${b}` : `${b}␟${a}`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function isContainment([a, b]: [string, string]): boolean {
  const na = norm(a), nb = norm(b);
  return na !== nb && na.length > 2 && nb.length > 2 && (na.includes(nb) || nb.includes(na));
}

async function runPass(
  graph: KnowledgeGraph,
  graphName: string,
  guidanceName: string,
  guidance: string,
  model: string
): Promise<{ tracePath: string; entitiesBefore: number; entitiesAfter: number }> {
  const tracePath = path.join(OUT_DIR, `${graphName}__${guidanceName}__${model.replace(/[^a-z0-9]/gi, "-")}.trace.jsonl`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(tracePath)) fs.unlinkSync(tracePath);
  trace.configure({ enabled: true, path: tracePath, runId: `${graphName}/${guidanceName}/${model}` });

  const options = parseConfig({
    pipeline: {
      canonicalization: {
        enabled: true,
        method: "hybrid",
        target: ["entities"],
        blockTopN: BLOCK_TOP_N,
        maxAdjudications: MAX_ADJ,
        hybrid: { escalateBand: [0.72, 0.88] },
        llm: { guidance },
      },
    },
    eval: { pinVersions: false },
  });
  const ctx: TransformContext = { options, embeddings, llm: makeLlm(model), logger: silentLogger };
  const before = graph.entities.length;
  const out = await new Canonicalizer().apply(graph, ctx);
  trace.reset();
  const adj = readDecisions(tracePath);
  console.log(
    `    [${guidanceName} × ${model}] adjudications=${adj.length} accepts=${adj.filter((d) => d.verdict).length} ` +
      `entities ${before}→${out.entities.length}`
  );
  return { tracePath, entitiesBefore: before, entitiesAfter: out.entities.length };
}

async function main() {
  console.log(`NEW (shipped) guidance head: "${NEW_GUIDANCE.slice(0, 70)}…"\n`);
  const results: any = { embModel: EMB_MODEL, blockTopN: BLOCK_TOP_N, maxAdj: MAX_ADJ, graphs: [] };

  for (const g of GRAPHS) {
    console.log(`\n################ ${g.name} (${g.path}) ################`);
    const graph = loadGraph(g.path);
    console.log(`  loaded ${graph.entities.length} entities, ${graph.relations.length} relations`);

    const models = g.arms === "small-only" ? [SMALL_MODEL] : [SMALL_MODEL, CAPABLE_MODEL];
    const passes: Record<string, Decision[]> = {};
    const counts: any[] = [];
    for (const model of models) {
      for (const [gn, gtext] of [["baseline", OLD_GUIDANCE], ["default", NEW_GUIDANCE]] as const) {
        const r = await runPass(graph, g.name, gn, gtext, model);
        passes[`${gn}|${model}`] = readDecisions(r.tracePath);
        counts.push({ guidance: gn, model, ...r, tracePath: undefined,
          adjudications: passes[`${gn}|${model}`].length,
          accepts: passes[`${gn}|${model}`].filter((d) => d.verdict).length });
      }
    }

    // ── per-model baseline→default analysis ──
    const perModel: any[] = [];
    for (const model of models) {
      const base = passes[`baseline|${model}`] ?? [];
      const def = passes[`default|${model}`] ?? [];
      const baseV = new Map(base.map((d) => [pairKey(d.pair), d.verdict]));
      const defByKey = new Map(def.map((d) => [pairKey(d.pair), d]));
      // pairs adjudicated under BOTH (clean before/after); newly-accepted = baseline reject → default accept
      const newlyAccepted: [string, string][] = [];
      const newlyRejected: [string, string][] = [];
      for (const [k, d] of defByKey) {
        if (!baseV.has(k)) continue;
        if (d.verdict && baseV.get(k) === false) newlyAccepted.push(d.pair);
        if (!d.verdict && baseV.get(k) === true) newlyRejected.push(d.pair);
      }
      const defAccepts = def.filter((d) => d.verdict).map((d) => d.pair);
      const containmentAccepts = defAccepts.filter(isContainment);
      perModel.push({
        model,
        baselineAccepts: base.filter((d) => d.verdict).length,
        defaultAccepts: def.filter((d) => d.verdict).length,
        sharedPairs: [...defByKey.keys()].filter((k) => baseV.has(k)).length,
        newlyAccepted, newlyRejected,
        defaultContainmentAccepts: containmentAccepts,
      });
      console.log(`\n  ── ${model} : baseline → default ──`);
      console.log(`    accepts ${base.filter((d) => d.verdict).length} → ${def.filter((d) => d.verdict).length}  ` +
        `(shared adjudicated pairs: ${[...defByKey.keys()].filter((k) => baseV.has(k)).length})`);
      console.log(`    newly ACCEPTED by softening (recall gain — eyeball for true-alias vs hypernym):`);
      for (const [a, b] of newlyAccepted) console.log(`        + ${a}  ≡?  ${b}${isContainment([a, b]) ? "   [containment]" : ""}`);
      if (newlyRejected.length) {
        console.log(`    newly REJECTED (rare):`);
        for (const [a, b] of newlyRejected) console.log(`        - ${a}  ✗  ${b}`);
      }
      console.log(`    default-guidance containment accepts (PRECISION watch — alias-containment ok, hypernym-containment = regression):`);
      for (const [a, b] of containmentAccepts) console.log(`        ? ${a}  ⊃?  ${b}`);
    }

    results.graphs.push({ name: g.name, entities: graph.entities.length, counts, perModel });
  }

  if (parseFailures) console.log(`\n⚠ ${parseFailures} verdict parse failure(s) (treated as reject)`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`\nResults + per-pass traces written under ${OUT_DIR}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
