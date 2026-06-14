/**
 * Lexical (char-n-gram) + semantic FUSION spike for canon candidate generation.
 * Throwaway investigation per docs/inbox/2026-06-14-dove-to-cheetah-bm25-fusion-spike.md.
 *
 * Thesis: a lexical-overlap channel, fused into CANDIDATE GENERATION (which pairs reach
 * the LLM adjudicator) — NOT the merge decision — rescues high-overlap containment aliases
 * (`UMAP projection ≡ UMAP`, `300-D embedding ≡ 300-D vector`) that the anisotropic embedding
 * space buries below the escalate band, WITHOUT pulling sibling/hypernym hard-negatives
 * (`cheese | cheddar cheese`, `enoki | shiitake`, `Apple | Mac`) into the candidate set.
 * Precision stays with the adjudicator + digit veto; lexical only widens recall of candidates.
 *
 * Embeddings-only, local, free (Ollama). No production code touched; no LLM adjudication here
 * (the spike measures the CANDIDATE set the adjudicator would receive, not merges).
 *
 * Run:  npx ts-node examples/sandbox/canon-fusion-spike.ts
 */
import * as fs from "fs";
import * as path from "path";
import { Ollama } from "ollama";
import { cosineSimilarity } from "../../src/shared/utils";
import { digitSignature } from "../../src/core/knowledge/merging/KnowledgeMerger";

// ── config ───────────────────────────────────────────────────────────────────
// mxbai-large: a solid local model from the embedding-bench (embeddinggemma had a
// negative d′). Fusion's benefit should be model-agnostic; one model keeps it readable.
const MODEL = "mxbai-embed-large:335m";
// The live escalate band (config default cfg.llm.band / hybrid.escalateBand = [0.72, 0.88]).
// A pair only reaches the adjudicator when its candidate score lands in/above the band low.
const BAND_LOW = 0.72;
// Blocking sizes to report at (cfg.canonicalization.blockTopN; examples/canon configs set it).
const BLOCK_NS = [5, 10];
const RRF_K = 60; // standard reciprocal-rank-fusion constant
const RESULTS_PATH = "examples/sandbox/canon-fusion-results.json";

// ── probe sets (copied from embedding-bench.ts — it exports nothing; self-contained) ──
type Pair = [string, string];
interface Corpus {
  name: string;
  graph: string;
  positives: Pair[]; // true co-referents (aliases) — SHOULD become candidates
  hardNegatives: Pair[]; // near-miss siblings/homonyms — should NOT become candidates
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
    hardNegatives: [
      ["Digital Signal Processors", "Image Signal Processors"],
      ["iPhone camera cluster", "iPad camera cluster"],
      ["MacBook webcam", "iMac webcam"],
      ["performance cores", "efficiency cores"],
      ["I–C edges", "I–I edges"],
      ["cheese", "cheddar cheese"],
      ["onion", "red onion"],
      ["white fleshed fish", "firm white fish"],
      ["Cuisine-clustering subset", "Food-group-clustering subset"],
      ["Epicure", "Epicure-Core"],
      ["enoki mushroom", "shiitake mushroom"],
      ["Apple", "Mac"],
      ["sweet dessert liqueurs and confections", "sweet liqueurs and cocktail ingredients"],
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
    hardNegatives: [
      ["EmbeddingService", "OpenAIEmbeddingService"],
      ["IEmbeddingProvider", "IEmbeddingService"],
      ["ChunkProvenance", "ChunkResult"],
      ["merge", "deepMerge"],
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
  },
];

// ── pure stats (copied from embedding-bench.ts) ──────────────────────────────
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

// ── lexical channels (pure) ──────────────────────────────────────────────────
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
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Containment-biased: 1.0 when one set ⊆ the other (the alias case AND the sibling trap). */
function overlapCoeff(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

type LexFn = (a: string, b: string) => number;
const LEXICALS: Record<string, LexFn> = {
  "trigram-jaccard": (a, b) => jaccard(charNGrams(a, 3), charNGrams(b, 3)),
  "trigram-overlap": (a, b) => overlapCoeff(charNGrams(a, 3), charNGrams(b, 3)),
  "token-jaccard": (a, b) => jaccard(wordTokens(a), wordTokens(b)),
};

// ── corpus loader (copied pattern from embedding-bench.ts) ────────────────────
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
    const r = await ollama.embeddings({ model: MODEL, prompt: texts[i] });
    out.set(texts[i], r.embedding);
    if ((i + 1) % 200 === 0) process.stdout.write(`    …${i + 1}/${texts.length}\r`);
  }
  return out;
}

// ── candidate-set simulation (the gate metric) ───────────────────────────────
// A pair is a "candidate" (would reach the adjudicator) iff it survives blocking:
// it is among either endpoint's top-N neighbours (mirrors blockingEligibility's
// symmetric top-N in src/shared/utils/agglomerativeCluster.ts). We rank neighbours
// per node under each scoring scheme and ask: is the probe partner in the top-N?

type RankMode = "cosine" | "rrf" | "weighted" | "or";

/** For node i, return the SET of node indices that are candidate partners under `mode`. */
function candidatePartners(
  i: number,
  n: number,
  cos: (i: number, j: number) => number,
  lex: (i: number, j: number) => number,
  topN: number,
  mode: RankMode
): Set<number> {
  const others = [...Array(n).keys()].filter((j) => j !== i);
  const byCos = [...others].sort((a, b) => cos(i, b) - cos(i, a));
  if (mode === "cosine") return new Set(byCos.slice(0, topN));
  const byLex = [...others].sort((a, b) => lex(i, b) - lex(i, a));
  if (mode === "or") {
    return new Set([...byCos.slice(0, topN), ...byLex.slice(0, topN)]);
  }
  if (mode === "rrf") {
    const cosRank = new Map<number, number>();
    byCos.forEach((j, r) => cosRank.set(j, r));
    const lexRank = new Map<number, number>();
    byLex.forEach((j, r) => lexRank.set(j, r));
    const scored = others
      .map((j) => ({
        j,
        s: 1 / (RRF_K + (cosRank.get(j) ?? n)) + 1 / (RRF_K + (lexRank.get(j) ?? n)),
      }))
      .sort((a, b) => b.s - a.s);
    return new Set(scored.slice(0, topN).map((x) => x.j));
  }
  // weighted: min-max normalize each channel over i's neighbours, equal-weight sum
  const cosV = others.map((j) => cos(i, j));
  const lexV = others.map((j) => lex(i, j));
  const norm = (v: number[], x: number) => {
    const lo = Math.min(...v), hi = Math.max(...v);
    return hi > lo ? (x - lo) / (hi - lo) : 0;
  };
  const scored = others
    .map((j) => ({ j, s: 0.5 * norm(cosV, cos(i, j)) + 0.5 * norm(lexV, lex(i, j)) }))
    .sort((a, b) => b.s - a.s);
  return new Set(scored.slice(0, topN).map((x) => x.j));
}

interface GateResult {
  corpus: string;
  blockTopN: number;
  lexical: string;
  fusion: RankMode;
  aliasesRescued: number; // positives newly candidate vs cosine baseline
  aliasesTotalCandidate: number; // positives that are candidates under fusion
  aliasesBaselineCandidate: number; // positives that were candidates under cosine
  siblingsPromoted: number; // hard-negatives newly candidate vs baseline (MUST be 0)
  candidatePairs: number; // total symmetric candidate pairs (budget)
  candidatePairsBaseline: number;
}

async function main() {
  const allResults: any = { model: MODEL, bandLow: BAND_LOW, blockNs: BLOCK_NS, corpora: [] };

  for (const corpus of CORPORA) {
    console.log(`\n\n################ ${corpus.name} ################`);
    const graphNames = loadNames(corpus.graph);
    const probeNames = [...new Set(corpus.positives.flat().concat(corpus.hardNegatives.flat()))];
    // Universe = graph entities ∪ probe members (+ a synthetic digit pair for the veto guard).
    const VETO_PAIR: Pair = ["Table 1", "Table 2"];
    const names = [...new Set([...graphNames, ...probeNames, ...VETO_PAIR])];
    const idx = new Map(names.map((nm, i) => [nm, i]));
    console.log(`corpus entities: ${graphNames.length}, universe: ${names.length}, probes: +${corpus.positives.length}/-${corpus.hardNegatives.length}`);

    console.log(`  embedding ${names.length} names with ${MODEL} …`);
    const emb = await embedAll(names);
    const vecs = names.map((nm) => emb.get(nm)!);

    // memoized cosine
    const cosCache = new Map<number, number>();
    const cos = (i: number, j: number): number => {
      if (i === j) return 1;
      const key = i < j ? i * names.length + j : j * names.length + i;
      let v = cosCache.get(key);
      if (v === undefined) {
        v = cosineSimilarity(vecs[i], vecs[j]);
        cosCache.set(key, v);
      }
      return v;
    };

    // ── Lens B: pairwise separation (AUC/d′) for cosine, each lexical, weighted-sum ──
    const pairScore = (pairs: Pair[], f: (a: string, b: string) => number) =>
      pairs.filter(([a, b]) => idx.has(a) && idx.has(b)).map(([a, b]) => f(a, b));
    const cosPair: LexFn = (a, b) => cos(idx.get(a)!, idx.get(b)!);
    const sep: any[] = [];
    const channels: Array<[string, LexFn]> = [
      ["cosine", cosPair],
      ...Object.entries(LEXICALS),
      // weighted pairwise fusion (global min-max over the probe scores at report time)
    ];
    // collect raw per-channel scores, then normalize cos+lex for a fused pairwise score
    const posByCh: Record<string, number[]> = {};
    const negByCh: Record<string, number[]> = {};
    for (const [label, f] of channels) {
      posByCh[label] = pairScore(corpus.positives, f);
      negByCh[label] = pairScore(corpus.hardNegatives, f);
      sep.push({ channel: label, auc: round(auc(posByCh[label], negByCh[label])), dprime: round(dPrime(posByCh[label], negByCh[label])) });
    }
    // pairwise weighted fusion = 0.5*norm(cos) + 0.5*norm(trigram-jaccard) over the probe pool
    for (const lx of ["trigram-jaccard", "trigram-overlap"]) {
      const allCos = [...posByCh["cosine"], ...negByCh["cosine"]];
      const allLex = [...posByCh[lx], ...negByCh[lx]];
      const nrm = (arr: number[], x: number) => {
        const lo = Math.min(...arr), hi = Math.max(...arr);
        return hi > lo ? (x - lo) / (hi - lo) : 0;
      };
      const fuse = (cv: number, lv: number) => 0.5 * nrm(allCos, cv) + 0.5 * nrm(allLex, lv);
      const pos = corpus.positives
        .filter(([a, b]) => idx.has(a) && idx.has(b))
        .map(([a, b]) => fuse(cosPair(a, b), LEXICALS[lx](a, b)));
      const neg = corpus.hardNegatives
        .filter(([a, b]) => idx.has(a) && idx.has(b))
        .map(([a, b]) => fuse(cosPair(a, b), LEXICALS[lx](a, b)));
      sep.push({ channel: `weighted(cos,${lx})`, auc: round(auc(pos, neg)), dprime: round(dPrime(pos, neg)) });
    }
    console.log("\n  ── separation (AUC / d′; pos=aliases vs neg=siblings) ──");
    for (const s of sep) console.log(`    ${s.channel.padEnd(26)} AUC ${fmt(s.auc)}  d′ ${fmt(s.dprime)}`);

    // ── Lens A: candidate-set membership (the gate) ──
    const n = names.length;
    const gateRows: GateResult[] = [];
    const isCandidate = (parts: Set<number>[], a: number, b: number) =>
      parts[a].has(b) || parts[b].has(a); // symmetric top-N (blockingEligibility)

    for (const topN of BLOCK_NS) {
      // baseline cosine partners per node
      const cosParts = names.map((_, i) => candidatePartners(i, n, cos, () => 0, topN, "cosine"));
      const baselineCand = (pairs: Pair[]) =>
        pairs.filter(([a, b]) => idx.has(a) && idx.has(b) && isCandidate(cosParts, idx.get(a)!, idx.get(b)!)).length;
      const cosPairCount = countPairs(cosParts);

      for (const [lxName, lxFn] of Object.entries(LEXICALS)) {
        const lex = (i: number, j: number) => (i === j ? 1 : lxFn(names[i], names[j]));
        for (const fusion of ["rrf", "weighted", "or"] as RankMode[]) {
          const parts = names.map((_, i) => candidatePartners(i, n, cos, lex, topN, fusion));
          const rescued = (pairs: Pair[]) =>
            pairs.filter(
              ([a, b]) =>
                idx.has(a) && idx.has(b) &&
                isCandidate(parts, idx.get(a)!, idx.get(b)!) &&
                !isCandidate(cosParts, idx.get(a)!, idx.get(b)!)
            ).length;
          const totalCand = (pairs: Pair[]) =>
            pairs.filter(([a, b]) => idx.has(a) && idx.has(b) && isCandidate(parts, idx.get(a)!, idx.get(b)!)).length;
          gateRows.push({
            corpus: corpus.name,
            blockTopN: topN,
            lexical: lxName,
            fusion,
            aliasesRescued: rescued(corpus.positives),
            aliasesTotalCandidate: totalCand(corpus.positives),
            aliasesBaselineCandidate: baselineCand(corpus.positives),
            siblingsPromoted: rescued(corpus.hardNegatives),
            candidatePairs: countPairs(parts),
            candidatePairsBaseline: cosPairCount,
          });
        }
      }
    }

    // ── digit-veto guard: the veto runs in decide() AFTER candidate gen. Confirm the
    // synthetic Table 1/Table 2 pair would be rejected by digitSignature regardless of
    // how high any fused candidate score is. ──
    const vetoHolds = digitSignature("Table 1") !== digitSignature("Table 2");

    console.log("\n  ── candidate gate (rescued aliases ↑ good, promoted siblings MUST be 0) ──");
    console.log("    blockN lexical          fusion    rescued  promoted  aliasCand(base→fused)  pairs(base→fused)");
    for (const g of gateRows) {
      console.log(
        `    ${String(g.blockTopN).padEnd(6)} ${g.lexical.padEnd(16)} ${g.fusion.padEnd(9)} ` +
          `${String(g.aliasesRescued).padStart(7)}  ${String(g.siblingsPromoted).padStart(8)}  ` +
          `${String(g.aliasesBaselineCandidate).padStart(9)}→${String(g.aliasesTotalCandidate).padEnd(6)}  ` +
          `${String(g.candidatePairsBaseline).padStart(8)}→${g.candidatePairs}`
      );
    }
    console.log(`\n  digit veto holds post-fusion (Table 1 ≠ Table 2): ${vetoHolds ? "YES ✓" : "NO ✗"}`);

    allResults.corpora.push({ name: corpus.name, separation: sep, gate: gateRows, vetoHolds });
  }

  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(allResults, null, 2) + "\n");
  console.log(`\n\nResults written to ${RESULTS_PATH}`);
}

/** Count distinct symmetric candidate pairs across all nodes' partner sets. */
function countPairs(parts: Set<number>[]): number {
  const seen = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    for (const j of parts[i]) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      seen.add(key);
    }
  }
  return seen.size;
}

const round = (x: number) => (Number.isNaN(x) ? NaN : Math.round(x * 1000) / 1000);
const fmt = (x: number) => (Number.isNaN(x) ? " n/a " : x.toFixed(3));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
