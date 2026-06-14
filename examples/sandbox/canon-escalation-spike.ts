/**
 * v2 GATED-ESCALATION spike for the canon DECISION path.
 * Per docs/inbox/2026-06-14-dove-to-cheetah-bm25-fusion-v2-decision.md (supersedes v1's placement).
 *
 * v1 (candidate-generation fusion) was a clean NO-GO: aliases reach the candidate set fine;
 * they die one stage later at decide()'s `cosine < 0.72 → reject`, which never reaches the
 * adjudicator. v2 redirects the lexical signal INTO the decision: if `cosine ∈ [floor, 0.72)`
 * AND `lexical_overlap ≥ τ`, ESCALATE the pair to the adjudicator instead of auto-rejecting.
 * Nothing auto-merges — the LLM adjudicator + digit veto still make every merge call. The
 * go/no-go is therefore ADJUDICATOR PRECISION on the narrow hypernym/substring band the gate
 * newly surfaces (`swiss cheese|cheese`, `Apple Silicon|Apple`) — true aliases are high lexical
 * overlap, lexically-dissimilar siblings (`enoki|shiitake`) never trip the gate, so only genuine
 * hypernyms burden the LLM.
 *
 * Phase 2 (always): metric bake-off (AUC/d′) + (τ,floor) sweep over the escalation set. Embeddings
 *                   only, local, free, no LLM. Auto-recommends an operating point.
 * Phase 3 (--adjudicate): runs the newly-escalated set at the recommended point through a FAITHFUL
 *                   reproduction of Canonicalizer.adjudicate (exact prompt + {merge:boolean} schema)
 *                   against gemma4:12b (local) AND gemma4:31b-cloud, side by side.
 *
 * Run:  npx ts-node examples/sandbox/canon-escalation-spike.ts
 *       npx ts-node examples/sandbox/canon-escalation-spike.ts --adjudicate
 */
import * as fs from "fs";
import * as path from "path";
import { Ollama } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { cosineSimilarity, parseJsonLenient } from "../../src/shared/utils";
import { digitSignature } from "../../src/core/knowledge/merging/KnowledgeMerger";

// ── config ───────────────────────────────────────────────────────────────────
const EMB_MODEL = "mxbai-embed-large:335m"; // best local from the embedding-bench
const BAND_LOW = 0.72; // the live escalate-band floor (cfg.llm.band / hybrid.escalateBand = [0.72,0.88])
const ADJ_MODELS = ["gemma4:12b", "gemma4:31b-cloud"]; // local + cloud adjudicators (side-by-side)
const MIN_FLOOR = 0.4; // lowest cosine floor considered in the sweep
const FLOORS = [0.4, 0.5, 0.6]; // cosine floors
const TAUS = [0.3, 0.4, 0.5, 0.6, 0.7]; // lexical-overlap thresholds
const SET_CAP = 400; // "low hundreds" — bound on the newly-escalated set for the recommendation
const UNLABELED_SAMPLE = 40; // unlabeled escalated pairs adjudicated per corpus (false-accept estimate)
const RESULTS_PATH = "examples/sandbox/canon-escalation-results.json";

// ── probe sets (v1 corpora; negatives re-partitioned into siblings vs hypernyms, + v2 hypernyms) ──
type Pair = [string, string];
interface Corpus {
  name: string;
  graph: string;
  positives: Pair[]; // true co-referents (aliases) — high lexical overlap, SHOULD recover
  siblings: Pair[]; // lexically-DISSIMILAR negatives — should never trip the gate
  hypernyms: Pair[]; // lexically-SIMILAR containment negatives — WILL trip the gate (adjudicator's burden)
}

const CORPORA: Corpus[] = [
  {
    name: "telegram-sink (mixed: ML+hardware+cuisine)",
    graph: "examples/kg-telegram-sink/data/output/graph.mcp-jsonl",
    positives: [
      ["ARMv8 architecture", "ARMv8"],
      ["ARM RISC architecture", "ARM RISC"],
      ["128-bit memory interface", "128-bit wide memory interface"],
      ["shared level 2 cache", "L2 cache"],
      ["UMAP projection", "UMAP"],
      ["300-D embedding", "300-D vector"],
      ["Mode coherence", "per-mode coherence"],
      ["FlavorGraph", "FlavorGraph nomenclature"],
      ["chemistry-vs-recipe-context spectrum", "chemistry-vs-recipe-context axis"],
      ["Mediterranean savory cooking staples", "Mediterranean savory pantry staples"],
      ["Gaussian-mixture-model (GMM) partition", "Gaussian-mixture-model"],
      ["macro-regional cuisine clusters", "cuisine macro-regions"],
      ["compound-feature (CF) sensory categories", "FlavorDB compound-feature (CF) sensory categories"],
      ["USDA macronutrient probes", "eight USDA-macronutrient probes"],
      ["chef-facing tools", "chef-facing interface"],
      ["NAND chips", "NAND storage devices"],
    ],
    siblings: [
      ["Digital Signal Processors", "Image Signal Processors"],
      ["iPhone camera cluster", "iPad camera cluster"],
      ["MacBook webcam", "iMac webcam"],
      ["performance cores", "efficiency cores"],
      ["I–C edges", "I–I edges"],
      ["white fleshed fish", "firm white fish"],
      ["Cuisine-clustering subset", "Food-group-clustering subset"],
      ["enoki mushroom", "shiitake mushroom"],
      ["Apple", "Mac"],
      ["sweet dessert liqueurs and confections", "sweet liqueurs and cocktail ingredients"],
    ],
    hypernyms: [
      ["cheese", "cheddar cheese"],
      ["onion", "red onion"],
      ["Epicure", "Epicure-Core"],
      ["swiss cheese", "cheese"], // v2 additions
      ["Apple Silicon", "Apple"],
      ["generative AI", "AI"],
    ],
  },
  {
    name: "wanshi self (code/technical)",
    graph: "kg_tests/self/kggt5-knowledge-graph.mcp-jsonl",
    positives: [
      ["calculateSimilarity", "cosineSimilarity"],
      ["readConfigurationFile", "readConfig"],
      ["Whisper ASR", "asr"],
      ["Graceful shutdown", "shutdown"],
      ["@tanstack/react-query", "react-query"],
      ["getSystemPrompt", "systemPrompt"],
      ["progressNdjson", "NdjsonProgressEmitter"],
      ["mission_statement", "system_mission_statement"],
      ["graceful_cancel", "graceful_interrupts"],
    ],
    siblings: [
      ["IEmbeddingProvider", "IEmbeddingService"],
      ["ChunkProvenance", "ChunkResult"],
      ["StructuralMetrics", "StructuralStats"],
      ["TextReader", "PdfReader"],
      ["TextReader", "MarkdownReader"],
      ["validateProcessedFile", "validateFile"],
      ["GroundingTransform", "GroundingMode"],
      ["IKnowledgeGraphMerger", "mergeGraphs"],
      ["OutlineGeneratorOptions", "OutlineOptions"],
      ["jaroWinklerSimilarity", "cosineSimilarity"],
      ["AudioReader", "ImageReader"],
      ["computeSemanticMetrics", "computeMetrics"],
    ],
    hypernyms: [
      ["EmbeddingService", "OpenAIEmbeddingService"],
      ["merge", "deepMerge"],
      ["interpretability", "autointerpretability"], // v2 additions
      ["EmbeddingService", "EmbeddingServiceFactory"],
    ],
  },
];

// ── pure stats (copied from embedding-bench.ts / v1 spike) ────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const variance = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1);
};
/** AUC = P(score(pos) > score(neg)); ties 0.5. */
function auc(pos: number[], neg: number[]): number {
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
/** Standardized separation between the two groups. */
function dPrime(pos: number[], neg: number[]): number {
  return (mean(pos) - mean(neg)) / Math.sqrt((variance(pos) + variance(neg)) / 2 + 1e-9);
}

// ── lexical channels (pure; same functions to be promoted to prod if Phase 3 passes) ──
/** Lowercased character n-grams (padded so short/containment strings still overlap). */
function charNGrams(s: string, n = 3): Set<string> {
  const t = ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const grams = new Set<string>();
  if (t.length < n) {
    grams.add(t);
    return grams;
  }
  for (let i = 0; i + n <= t.length; i++) grams.add(t.slice(i, i + n));
  return grams;
}
function wordTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}
function overlapCoeff(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const METRICS = ["trigram-overlap", "token-overlap", "token-jaccard"] as const;
type MetricName = (typeof METRICS)[number];
// Precomputed per-name feature sets keyed by name → {tri, tok}; lexical(i,j) is then set arithmetic.
type Feats = { tri: Set<string>; tok: Set<string> };
function lexical(metric: MetricName, fa: Feats, fb: Feats): number {
  switch (metric) {
    case "trigram-overlap":
      return overlapCoeff(fa.tri, fb.tri);
    case "token-overlap":
      return overlapCoeff(fa.tok, fb.tok);
    case "token-jaccard":
      return jaccard(fa.tok, fb.tok);
  }
}

// ── corpus loader (copied from v1 spike) ──────────────────────────────────────
function loadNames(graph: string): string[] {
  if (!fs.existsSync(graph)) {
    console.warn(`  ! corpus graph missing: ${graph} — using probe names only`);
    return [];
  }
  return [
    ...new Set(
      fs
        .readFileSync(graph, "utf8")
        .trim()
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((o) => o && o.type === "entity" && typeof o.name === "string")
        .map((o) => o.name as string)
    ),
  ];
}

const ollama = new Ollama();
async function embedAll(texts: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const r = await ollama.embeddings({ model: EMB_MODEL, prompt: texts[i] });
    out.set(texts[i], r.embedding);
    if ((i + 1) % 200 === 0) process.stdout.write(`    …${i + 1}/${texts.length}\r`);
  }
  return out;
}

// ── faithful adjudicator (Canonicalizer.adjudicate :289-297 verbatim) ─────────
const ADJ_SCHEMA = z.object({ merge: z.boolean() });
const ADJ_FORMAT = zodToJsonSchema(ADJ_SCHEMA);
function stripCodeFence(content: string): string {
  if (content.startsWith("```")) return content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\n"));
  return content;
}
function parseMerge(raw: string): boolean | null {
  const c = stripCodeFence(raw.trim());
  try {
    return ADJ_SCHEMA.parse(parseJsonLenient(c)).merge === true;
  } catch {
    // gemma4:31b-cloud ignores the json_schema `format` and emits bare `merge: true`.
    const m = c.match(/merge["']?\s*[:=]\s*(true|false)/i);
    if (m) return m[1].toLowerCase() === "true";
    return null;
  }
}
async function adjudicate(model: string, a: string, b: string): Promise<boolean | null> {
  try {
    const res = await ollama.chat({
      model,
      messages: [
        {
          role: "system",
          content:
            "You decide whether two surface forms refer to the SAME thing. " +
            "Answer only by setting `merge` true (same) or false (distinct). " +
            "Be conservative: distinct versions/models/sizes are NOT the same.",
        },
        { role: "user", content: `Do these entity names refer to the same thing?\nA: "${a}"\nB: "${b}"` },
      ],
      format: ADJ_FORMAT,
      think: false,
      options: { temperature: 0.1 },
    });
    return parseMerge(res.message.content);
  } catch (err) {
    console.warn(`    ! adjudication error (${model}) "${a}" vs "${b}": ${err}`);
    return null;
  }
}

// ── types for results ─────────────────────────────────────────────────────────
interface SweepCell {
  metric: MetricName;
  tau: number;
  floor: number;
  escalatedAliases: number; // recoverable aliases (cos<0.72) now escalated
  recoverableAliases: number; // aliases with cos<0.72 (the denominator)
  escalatedSetSize: number; // total newly-escalated universe pairs (adjudication burden)
  escalatedHypernyms: number; // curated hypernyms in the set (must be adjudicated to reject)
  escalatedSiblings: number; // curated siblings in the set (should be ~0)
}
type BandPair = { i: number; j: number; cos: number; lex: Record<MetricName, number>; label: PairLabel };
type PairLabel = "alias" | "sibling" | "hypernym" | "unlabeled";

function pairKey(a: string, b: string): string {
  return a < b ? `${a}␟${b}` : `${b}␟${a}`;
}

async function main() {
  const adjudicateOn = process.argv.includes("--adjudicate");
  const results: any = {
    embeddingModel: EMB_MODEL,
    bandLow: BAND_LOW,
    adjudicators: ADJ_MODELS,
    corpora: [],
  };

  // Per-corpus precomputed state retained for Phase 3.
  const retained: Array<{
    corpus: Corpus;
    names: string[];
    idx: Map<string, number>;
    feats: Feats[];
    cos: (i: number, j: number) => number;
    bandPairs: BandPair[];
    labelOf: Map<string, PairLabel>;
  }> = [];

  for (const corpus of CORPORA) {
    console.log(`\n\n################ ${corpus.name} ################`);
    const graphNames = loadNames(corpus.graph);
    const probePairs = [...corpus.positives, ...corpus.siblings, ...corpus.hypernyms];
    const probeNames = [...new Set(probePairs.flat())];
    const VETO_PAIR: Pair = ["Table 1", "Table 2"]; // digit-veto guard
    const names = [...new Set([...graphNames, ...probeNames, ...VETO_PAIR])];
    const idx = new Map(names.map((nm, i) => [nm, i]));
    const n = names.length;
    console.log(
      `corpus entities: ${graphNames.length}, universe: ${n}, probes: ` +
        `+${corpus.positives.length} aliases / ${corpus.siblings.length} siblings / ${corpus.hypernyms.length} hypernyms`
    );

    console.log(`  embedding ${n} names with ${EMB_MODEL} …`);
    const emb = await embedAll(names);
    const vecs = names.map((nm) => emb.get(nm)!);
    const feats: Feats[] = names.map((nm) => ({ tri: charNGrams(nm, 3), tok: wordTokens(nm) }));

    const cosCache = new Map<number, number>();
    const cos = (i: number, j: number): number => {
      if (i === j) return 1;
      const key = i < j ? i * n + j : j * n + i;
      let v = cosCache.get(key);
      if (v === undefined) {
        v = cosineSimilarity(vecs[i], vecs[j]);
        cosCache.set(key, v);
      }
      return v;
    };

    // Label lookup for probe pairs.
    const labelOf = new Map<string, PairLabel>();
    for (const [a, b] of corpus.positives) labelOf.set(pairKey(a, b), "alias");
    for (const [a, b] of corpus.siblings) labelOf.set(pairKey(a, b), "sibling");
    for (const [a, b] of corpus.hypernyms) labelOf.set(pairKey(a, b), "hypernym");

    // ── Lens A: metric bake-off (AUC/d′) ──
    // alias-vs-sibling (should separate cleanly) AND alias-vs-hypernym (the hard, unseparable
    // confusion class — expected ~0.5; that's *why* the adjudicator, not the metric, decides).
    const valid = (pairs: Pair[]) => pairs.filter(([a, b]) => idx.has(a) && idx.has(b));
    const lexScores = (pairs: Pair[], m: MetricName) =>
      valid(pairs).map(([a, b]) => lexical(m, feats[idx.get(a)!], feats[idx.get(b)!]));
    const sepAliasSibling: any[] = [];
    const sepAliasHypernym: any[] = [];
    for (const m of METRICS) {
      const pos = lexScores(corpus.positives, m);
      const sib = lexScores(corpus.siblings, m);
      const hyp = lexScores(corpus.hypernyms, m);
      sepAliasSibling.push({ metric: m, auc: round(auc(pos, sib)), dprime: round(dPrime(pos, sib)) });
      sepAliasHypernym.push({ metric: m, auc: round(auc(pos, hyp)), dprime: round(dPrime(pos, hyp)) });
    }
    console.log("\n  ── lexical separation (AUC / d′) ──");
    console.log("    metric            alias-vs-sibling      alias-vs-hypernym");
    for (let i = 0; i < METRICS.length; i++) {
      const s = sepAliasSibling[i],
        h = sepAliasHypernym[i];
      console.log(
        `    ${METRICS[i].padEnd(16)} AUC ${fmt(s.auc)} d′ ${fmt(s.dprime)}    AUC ${fmt(h.auc)} d′ ${fmt(h.dprime)}`
      );
    }

    // ── band pairs: all universe pairs with cos ∈ [MIN_FLOOR, BAND_LOW); compute lexical once. ──
    console.log(`\n  scanning ${((n * (n - 1)) / 2).toLocaleString()} pairs for the cos band [${MIN_FLOOR}, ${BAND_LOW}) …`);
    const bandPairs: BandPair[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const c = cos(i, j);
        if (c < MIN_FLOOR || c >= BAND_LOW) continue;
        const lex: Record<MetricName, number> = {
          "trigram-overlap": overlapCoeff(feats[i].tri, feats[j].tri),
          "token-overlap": overlapCoeff(feats[i].tok, feats[j].tok),
          "token-jaccard": jaccard(feats[i].tok, feats[j].tok),
        };
        const label = labelOf.get(pairKey(names[i], names[j])) ?? "unlabeled";
        bandPairs.push({ i, j, cos: c, lex, label });
      }
    }
    console.log(`  band pairs (candidates for escalation): ${bandPairs.length}`);

    // recoverable aliases = curated aliases whose cosine < BAND_LOW (baseline auto-rejects them)
    const aliasCos = valid(corpus.positives).map(([a, b]) => ({ a, b, c: cos(idx.get(a)!, idx.get(b)!) }));
    const recoverable = aliasCos.filter((x) => x.c < BAND_LOW);
    console.log(
      `  curated aliases below the band (baseline-rejected, recovery targets): ${recoverable.length}/${aliasCos.length}`
    );

    // ── Lens B: (τ, floor) sweep ──
    const sweep: SweepCell[] = [];
    for (const metric of METRICS) {
      for (const floor of FLOORS) {
        for (const tau of TAUS) {
          const inSet = bandPairs.filter((p) => p.cos >= floor && p.lex[metric] >= tau);
          const escAliases = recoverable.filter((x) => {
            const i = idx.get(x.a)!,
              j = idx.get(x.b)!;
            return x.c >= floor && lexical(metric, feats[i], feats[j]) >= tau;
          }).length;
          sweep.push({
            metric,
            tau,
            floor,
            escalatedAliases: escAliases,
            recoverableAliases: recoverable.length,
            escalatedSetSize: inSet.length,
            escalatedHypernyms: inSet.filter((p) => p.label === "hypernym").length,
            escalatedSiblings: inSet.filter((p) => p.label === "sibling").length,
          });
        }
      }
    }

    console.log("\n  ── (τ,floor) sweep ── (escAlias↑ recover, set=burden, hyp=adjudicator load, sib≈0) ──");
    console.log("    metric           floor  τ     escAlias/recov   setSize   hyp   sib");
    for (const c of sweep) {
      console.log(
        `    ${c.metric.padEnd(16)} ${c.floor.toFixed(2)}  ${c.tau.toFixed(2)}  ` +
          `${String(c.escalatedAliases).padStart(7)}/${String(c.recoverableAliases).padEnd(4)}  ` +
          `${String(c.escalatedSetSize).padStart(7)}  ${String(c.escalatedHypernyms).padStart(4)}  ${String(c.escalatedSiblings).padStart(4)}`
      );
    }

    const vetoHolds = digitSignature("Table 1") !== digitSignature("Table 2");
    console.log(`\n  digit veto (Table 1 ≠ Table 2): ${vetoHolds ? "YES ✓" : "NO ✗"}`);

    results.corpora.push({
      name: corpus.name,
      sizes: { entities: graphNames.length, universe: n },
      separation: { aliasVsSibling: sepAliasSibling, aliasVsHypernym: sepAliasHypernym },
      recoverableAliases: recoverable.length,
      totalAliases: aliasCos.length,
      bandPairs: bandPairs.length,
      sweep,
      vetoHolds,
    });
    retained.push({ corpus, names, idx, feats, cos, bandPairs, labelOf });
  }

  // ── recommend an operating point: max total escalatedAliases s.t. max setSize ≤ SET_CAP, ──
  //    prefer 0 escalated siblings, tie-break smaller set. ──
  const recommended = recommendOperatingPoint(results.corpora);
  results.recommended = recommended;
  console.log(`\n\n================ RECOMMENDED OPERATING POINT ================`);
  console.log(
    `  metric=${recommended.metric}  τ=${recommended.tau}  floor=${recommended.floor}\n` +
      `  → escalated aliases (per corpus): ${recommended.perCorpus.map((c: any) => `${c.escalatedAliases}/${c.recoverableAliases}`).join(", ")}\n` +
      `  → newly-escalated set size (per corpus): ${recommended.perCorpus.map((c: any) => c.escalatedSetSize).join(", ")}\n` +
      `  → escalated hypernyms / siblings: ${recommended.perCorpus.map((c: any) => `${c.escalatedHypernyms}/${c.escalatedSiblings}`).join(", ")}\n` +
      `  rationale: ${recommended.rationale}`
  );

  // ── Phase 3: adjudicate the newly-escalated set at the recommended point ──
  if (adjudicateOn) {
    results.adjudication = await runAdjudication(retained, recommended);
  } else {
    console.log(`\n(Phase 3 skipped — re-run with --adjudicate to hit ${ADJ_MODELS.join(" + ")}.)`);
  }

  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nResults written to ${RESULTS_PATH}`);
}

function recommendOperatingPoint(corpora: any[]): any {
  // Build the cartesian of cells keyed by (metric,tau,floor) aggregated across corpora.
  const byKey = new Map<string, { metric: MetricName; tau: number; floor: number; cells: SweepCell[] }>();
  for (const corpus of corpora) {
    for (const cell of corpus.sweep as SweepCell[]) {
      const k = `${cell.metric}|${cell.tau}|${cell.floor}`;
      if (!byKey.has(k)) byKey.set(k, { metric: cell.metric, tau: cell.tau, floor: cell.floor, cells: [] });
      byKey.get(k)!.cells.push(cell);
    }
  }
  let best: any = null;
  for (const { metric, tau, floor, cells } of byKey.values()) {
    const maxSet = Math.max(...cells.map((c) => c.escalatedSetSize));
    const sumAlias = cells.reduce((a, c) => a + c.escalatedAliases, 0);
    const sumSib = cells.reduce((a, c) => a + c.escalatedSiblings, 0);
    const minAliasPerCorpus = Math.min(...cells.map((c) => c.escalatedAliases));
    if (maxSet > SET_CAP) continue;
    const cand = {
      metric,
      tau,
      floor,
      maxSet,
      sumAlias,
      sumSib,
      minAliasPerCorpus,
      perCorpus: cells.map((c) => ({
        corpus: corpora.find((co) => (co.sweep as SweepCell[]).includes(c))?.name,
        escalatedAliases: c.escalatedAliases,
        recoverableAliases: c.recoverableAliases,
        escalatedSetSize: c.escalatedSetSize,
        escalatedHypernyms: c.escalatedHypernyms,
        escalatedSiblings: c.escalatedSiblings,
      })),
    };
    // Prefer: ≥1 alias in EVERY corpus, then more total aliases, then fewer siblings, then smaller set.
    if (
      !best ||
      betterThan(cand, best)
    )
      best = cand;
  }
  if (!best) {
    return { metric: "token-overlap", tau: 0.5, floor: 0.5, rationale: "no cell fit the cap; default", perCorpus: [] };
  }
  best.rationale =
    `max escalated aliases (min ${best.minAliasPerCorpus}/corpus, ${best.sumAlias} total) ` +
    `with the newly-escalated set ≤ ${SET_CAP} (max ${best.maxSet}) and ${best.sumSib} escalated siblings.`;
  return best;
}
function betterThan(a: any, b: any): boolean {
  const aOk = a.minAliasPerCorpus >= 1 ? 1 : 0;
  const bOk = b.minAliasPerCorpus >= 1 ? 1 : 0;
  if (aOk !== bOk) return aOk > bOk;
  if (a.sumAlias !== b.sumAlias) return a.sumAlias > b.sumAlias;
  if (a.sumSib !== b.sumSib) return a.sumSib < b.sumSib;
  return a.maxSet < b.maxSet;
}

type Zone = "reject(<0.72)" | "escalate[0.72,0.88)" | "auto-merge(≥0.88)";
function zoneOf(c: number): Zone {
  return c >= 0.88 ? "auto-merge(≥0.88)" : c >= BAND_LOW ? "escalate[0.72,0.88)" : "reject(<0.72)";
}
type ProbePair = { a: string; b: string; cos: number; zone: Zone };

/**
 * Phase 3 reframed by the Phase-2 finding (0 sub-0.72 aliases to recover): the question is no
 * longer "does the adjudicator hold precision on a newly-surfaced band" — it's "where does canon
 * actually lose the curated aliases?" So we (1) adjudicate ALL curated aliases bucketed by band
 * zone (recall, esp. the escalate band production actually consults), (2) adjudicate curated
 * hypernyms (precision), (3) adjudicate a sample of the unlabeled band v2's gate WOULD add (the
 * cost-for-nothing it buys). Both models, side by side.
 */
async function runAdjudication(retained: any[], rec: any): Promise<any> {
  console.log(`\n\n================ PHASE 3 — adjudication (${ADJ_MODELS.join(", ")}) ================`);
  const { metric, tau, floor } = rec as { metric: MetricName; tau: number; floor: number };
  const out: any = { metric, tau, floor, perCorpus: [] };

  for (const r of retained) {
    const { corpus, names, feats, idx, cos, bandPairs } = r;
    const probe = (pairs: Pair[]): ProbePair[] =>
      pairs
        .filter(([a, b]) => idx.has(a) && idx.has(b))
        .map(([a, b]) => {
          const c = cos(idx.get(a)!, idx.get(b)!);
          return { a, b, cos: round(c), zone: zoneOf(c) };
        });
    const aliases = probe(corpus.positives);
    const hypernyms = probe(corpus.hypernyms);
    // The band v2's gate would newly escalate (unlabeled corpus pairs only).
    const newlyEscalated: BandPair[] = bandPairs.filter(
      (p: BandPair) => p.cos >= floor && p.lex[metric] >= tau && p.label === "unlabeled"
    );
    const sample = shuffle(newlyEscalated).slice(0, UNLABELED_SAMPLE);

    const ti = idx.get("Table 1")!,
      tj = idx.get("Table 2")!;
    const vetoPairTripsLexical = lexical(metric, feats[ti], feats[tj]) >= tau;
    const vetoHolds = digitSignature("Table 1") !== digitSignature("Table 2");

    console.log(
      `\n  ${corpus.name}\n  curated aliases by zone: ` +
        ["reject(<0.72)", "escalate[0.72,0.88)", "auto-merge(≥0.88)"]
          .map((z) => `${z.split("(")[0]}=${aliases.filter((x) => x.zone === z).length}`)
          .join("  ") +
        `\n  v2 would newly-escalate ${newlyEscalated.length} unlabeled pairs (sampling ${sample.length})`
    );

    const perModel: any[] = [];
    for (const model of ADJ_MODELS) {
      console.log(`    — adjudicating with ${model} …`);
      const judgeProbe = async (pairs: ProbePair[]) => {
        const v: Array<ProbePair & { merge: boolean | null }> = [];
        for (const p of pairs) v.push({ ...p, merge: await adjudicate(model, p.a, p.b) });
        return v;
      };
      const judgeBand = async (pairs: BandPair[]) => {
        const v: Array<{ a: string; b: string; cos: number; lex: number; merge: boolean | null }> = [];
        for (const p of pairs)
          v.push({ a: names[p.i], b: names[p.j], cos: round(p.cos), lex: round(p.lex[metric]), merge: await adjudicate(model, names[p.i], names[p.j]) });
        return v;
      };
      const aliasV = await judgeProbe(aliases);
      const hypV = await judgeProbe(hypernyms);
      const sampleV = await judgeBand(sample);
      const acc = (v: any[]) => v.filter((x) => x.merge === true).length;
      const inBand = aliasV.filter((x) => x.zone === "escalate[0.72,0.88)");
      const m = {
        model,
        aliasRecallAll: `${acc(aliasV)}/${aliasV.length}`, // overall recall on curated aliases
        aliasRecallEscalateBand: `${acc(inBand)}/${inBand.length}`, // recall where production ACTUALLY adjudicates
        hypernymAccepted: `${acc(hypV)}/${hypV.length}`, // precision (want 0)
        newlyEscalatedAccepted: `${acc(sampleV)}/${sampleV.length}`, // the band v2 adds (mostly noise)
        rejectedTrueAliases: aliasV.filter((x) => x.merge !== true).map((x) => `${x.a} ✗ ${x.b} (cos ${x.cos}, ${x.zone})`),
        falseAcceptedHypernyms: hypV.filter((x) => x.merge === true).map((x) => `${x.a} ✗ ${x.b} (cos ${x.cos})`),
        newlyEscalatedAccepts: sampleV.filter((x) => x.merge === true).map((x) => `${x.a} ? ${x.b} (cos ${x.cos}, lex ${x.lex})`),
        verdicts: { alias: aliasV, hypernym: hypV, newlyEscalatedSample: sampleV },
      };
      perModel.push(m);
      console.log(
        `      alias-recall(all) ${m.aliasRecallAll}  alias-recall(escalate-band) ${m.aliasRecallEscalateBand}  ` +
          `hypernym-accept ${m.hypernymAccepted} (want 0)  newly-escalated-accept ${m.newlyEscalatedAccepted}`
      );
    }

    out.perCorpus.push({
      name: corpus.name,
      aliasZones: {
        reject: aliases.filter((x) => x.zone === "reject(<0.72)").length,
        escalate: aliases.filter((x) => x.zone === "escalate[0.72,0.88)").length,
        autoMerge: aliases.filter((x) => x.zone === "auto-merge(≥0.88)").length,
      },
      newlyEscalatedUnlabeled: newlyEscalated.length,
      sampled: sample.length,
      digitVeto: { tripsLexicalGate: vetoPairTripsLexical, vetoHolds },
      perModel,
    });
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const round = (x: number) => (Number.isNaN(x) ? NaN : Math.round(x * 1000) / 1000);
const fmt = (x: number) => (Number.isNaN(x) ? " n/a " : x.toFixed(3));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
