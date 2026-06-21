#!/usr/bin/env ts-node
/**
 * CrossRE two-way comparison: wanshi vs KGGen, SAME model, gold-labeled.
 *
 * The complement to the MINE sweep. MINE is retrieve+judge RECALL (rewards triple
 * coverage, blind to precision); CrossRE is gold-labeled PRECISION+RECALL F1 across 6
 * domains. Together they answer: is KGGen's MINE win a real extraction edge, or a
 * MINE-metric artifact? (CrossRE may tell the opposite story — wanshi's canonicalization
 * could surface here as precision.)
 *
 * CrossRE ships no baseline graphs, so KGGen is run separately (scripts/kggen-crossre.py)
 * and cached to disk; this script extracts wanshi inline, then re-scores BOTH tools with
 * the SAME matchers (the MINE "re-score stored baselines" pattern). Both tools read the
 * SAME dumped sample list — the explicit anti-desync guard.
 *
 * Run order (idempotent / resumable):
 *   1) npx ts-node scripts/crossre-compare.ts --model deepseek/deepseek-v4-pro --per-domain 50 \
 *        --provider openai --host https://openrouter.ai/api/v1
 *        -> dumps samples.jsonl + extracts/caches wanshi + prints wanshi-only table
 *   2) .venv-kggen/bin/python scripts/kggen-crossre.py --model deepseek/deepseek-v4-pro
 *        -> caches KGGen graphs
 *   3) re-run (1) -> wanshi from cache (no re-spend) + KGGen from cache -> full two-way table
 *
 * Metric note: CrossRE's 17 gold predicates are abstract; wanshi/KGGen emit FREE predicates,
 * so relation/triple F1 understate UNIFORMLY (reported, caveated). The fair cross-tool
 * headline is semantic ENTITY-level F1 (did the tool recover the gold entities).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ContainerFactory, TYPES } from '../src/core/di';
import { parseConfig } from '../src/config';
import { KnowledgeGraphBuilder } from '../src/core/knowledge/KnowledgeGraphBuilder';
import { PromptManager } from '../src/core/llm/prompts/PromptManager';
import { EmbeddingService } from '../src/core/llm/EmbeddingService';
import { Logger } from '../src/shared';
import { ProcessingOptions } from '../src/types';
import { ProcessedFile } from '../src/types/IProcessingService';
import { KnowledgeGraph } from '../src/types/KnowledgeGraph';
import {
  CrossREDataset,
  ExactMatcher,
  SemanticMatcher,
  computeExactMetrics,
  computeSemanticMetrics,
  computeMetrics,
  microAverage,
  MineDataset,
} from '../src/evaluation';
import { BenchmarkSample, EvalMetrics, LevelMetrics, Triplet } from '../src/evaluation/datasets/IDataset';
import { kgToTriplets, nodeTriplets } from '../src/evaluation/crossre/compareScoring';

const ALL_DOMAINS = ['ai', 'literature', 'music', 'news', 'politics', 'science'];

/** Minimal .env loader (mirrors scripts/benchmark.ts) — no dotenv dep. */
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function buildProcessingOptions(opts: {
  provider: string; model: string; host: string; apiKey?: string;
  embeddingsProvider: string; embeddingsModel: string; embeddingsHost: string;
  promptVersion: string;
}): ProcessingOptions {
  return parseConfig({
    input: 'benchmark',
    filter: ['**/*.txt'],
    output: 'benchmark-kg.json',
    description: 'Benchmark evaluation',
    llm: {
      provider: opts.provider, model: opts.model, host: opts.host,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      temperature: 0, repeatPenalty: 1.1, contextLength: 8192, seed: 42,
      promptVersion: opts.promptVersion,
    },
    embeddings: {
      provider: opts.embeddingsProvider, model: opts.embeddingsModel, host: opts.embeddingsHost,
      ...(opts.apiKey && opts.embeddingsProvider === 'openai' ? { apiKey: opts.apiKey } : {}),
    },
    chunking: { mode: 'disabled' },
    retrieval: { mode: 'disabled' },
    corpus: { profiling: 'disabled' },
    grounding: { mode: 'disabled' },
    classifier: { mode: 'disabled' },
    readers: { asr: { mode: 'disabled' }, images: 'disabled', outline: { enabled: false } },
    logging: { level: 'info' },
  });
}

function textToProcessedFile(text: string, id: string): ProcessedFile {
  return {
    path: `benchmark/${id}.txt`,
    chunks: [{ content: text, index: 1, totalChunks: 1, startOffset: 0, endOffset: text.length }],
    metadata: {},
  };
}

// ─── JSONL cache (append + load + truncation-tolerant; the CheckpointService idiom) ──
function loadJsonl<T = any>(file: string): Map<string, T> {
  const map = new Map<string, T>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && rec.id !== undefined) map.set(rec.id, rec);
    } catch {
      /* tolerate a truncated final line from an interrupted write */
    }
  }
  return map;
}

function appendJsonl(file: string, rec: unknown): void {
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8');
}

const f3 = (n: number) => n.toFixed(3);

interface ToolScore {
  /** Entity-capture over the full node set (the fair headline), semantic + exact. */
  nodeEntitySem: EvalMetrics;
  nodeEntityExact: EvalMetrics;
  /** Triplet-derived levels (entity = relation endpoints; relation; triple). */
  tripletSem: LevelMetrics;
  tripletExact: LevelMetrics;
  /** Per-domain node entity-capture (semantic) F1. */
  perDomainNode: Map<string, EvalMetrics>;
  triplesPer: number;
  entsPer: number;
}

type Tally = { tp: number; fp: number; fn: number };
const addTally = (a: Tally, b: { tp: number; fp: number; fn: number }) => {
  a.tp += b.tp; a.fp += b.fp; a.fn += b.fn;
};

async function scoreTool(
  ids: string[],
  graphById: Map<string, KnowledgeGraph>,
  goldById: Map<string, Triplet[]>,
  domainById: Map<string, string>,
  exact: ExactMatcher,
  semantic: SemanticMatcher,
): Promise<ToolScore> {
  const exactTrip: LevelMetrics[] = [];
  const semTrip: LevelMetrics[] = [];
  const nodeSem: Tally = { tp: 0, fp: 0, fn: 0 };   // micro-averaged across samples
  const nodeExact: Tally = { tp: 0, fp: 0, fn: 0 };
  const nodeByDomain = new Map<string, Tally>();
  let triples = 0, ents = 0;

  for (const id of ids) {
    const kg = graphById.get(id) ?? { entities: [], relations: [] };
    const gold = goldById.get(id) ?? [];
    const trip = kgToTriplets(kg);
    const nodes = nodeTriplets(kg);
    triples += trip.length;
    ents += kg.entities.length;

    exactTrip.push(computeExactMetrics(trip, gold, exact));
    semTrip.push(await computeSemanticMetrics(trip, gold, semantic));

    // Node entity-capture: match the full node set against gold entities.
    const ns = await semantic.matchEntities(nodes, gold);
    addTally(nodeSem, ns);
    addTally(nodeExact, exact.matchEntities(nodes, gold));

    const d = domainById.get(id) ?? 'unknown';
    if (!nodeByDomain.has(d)) nodeByDomain.set(d, { tp: 0, fp: 0, fn: 0 });
    addTally(nodeByDomain.get(d)!, ns);
  }

  const perDomainNode = new Map<string, EvalMetrics>();
  for (const [d, t] of nodeByDomain) perDomainNode.set(d, computeMetrics(t.tp, t.fp, t.fn));

  return {
    nodeEntitySem: computeMetrics(nodeSem.tp, nodeSem.fp, nodeSem.fn),
    nodeEntityExact: computeMetrics(nodeExact.tp, nodeExact.fp, nodeExact.fn),
    tripletSem: microAverage(semTrip),
    tripletExact: microAverage(exactTrip),
    perDomainNode,
    triplesPer: ids.length ? triples / ids.length : 0,
    entsPer: ids.length ? ents / ids.length : 0,
  };
}

const program = new Command('crossre-compare');
program
  .description('CrossRE two-way: wanshi vs KGGen (same model), gold-labeled F1')
  .option('--model <name>', 'Model id (same for both tools)', 'deepseek/deepseek-v4-pro')
  .option('--provider <name>', 'Generation provider: ollama | openai', 'openai')
  .option('--host <url>', 'OpenAI-compatible base URL', 'https://openrouter.ai/api/v1')
  .option('--api-key <key>', 'API key (else $OPENAI_API_KEY / .env)')
  .option('--data-path <path>', 'CrossRE crossre_data directory', 'data/crossre/crossre_data')
  .option('--domains <list>', 'Comma-separated domains', ALL_DOMAINS.join(','))
  .option('--per-domain <n>', 'Max usable samples per domain', '50')
  .option('--limit <n>', 'Hard cap on total samples (0 = no cap)', '0')
  .option('--embeddings-provider <n>', 'Embeddings provider', 'ollama')
  .option('--embeddings-model <name>', 'Embedding model (local & free)', 'nomic-embed-text')
  .option('--embeddings-host <url>', 'Embeddings host', 'http://localhost:11434')
  .option('--match-threshold <n>', 'Semantic match threshold', '0.80')
  .option('--prompt-version <ver>', 'wanshi prompt version', 'v5')
  .option('--cache-dir <dir>', 'Cache dir for samples/wanshi/kggen JSONL', 'data/crossre/compare')
  .option('--output <path>', 'Two-way JSON report path')
  .action(async (opts) => {
    loadDotEnv();
    const perDomain = parseInt(opts.perDomain, 10) || 50;
    const hardLimit = parseInt(opts.limit, 10) || 0;
    const threshold = parseFloat(opts.matchThreshold);
    const domains = (opts.domains as string).split(',').map((s) => s.trim()).filter(Boolean);
    const cacheDir = opts.cacheDir as string;
    const output = (opts.output as string) ||
      `results/crossre/${(opts.model as string).replace(/[/:.]/g, '_')}__wanshi-vs-kggen.json`;

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });

    const processingOptions = buildProcessingOptions({
      provider: opts.provider, model: opts.model, host: opts.host,
      apiKey: opts.apiKey || process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY,
      embeddingsProvider: opts.embeddingsProvider, embeddingsModel: opts.embeddingsModel,
      embeddingsHost: opts.embeddingsHost, promptVersion: opts.promptVersion,
    });
    const container = ContainerFactory.createContainer({ processingOptions });
    const logger = await container.resolve<Logger>(TYPES.Logger);
    const kgBuilder = await container.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
    const promptManager = (await container.resolve(TYPES.PromptManager)) as PromptManager;
    const embeddingService = await container.resolve<EmbeddingService>(TYPES.EmbeddingService);

    // ── Load + per-domain cap (deterministic) ──
    const raw = await new CrossREDataset().load(opts.dataPath, Number.MAX_SAFE_INTEGER, domains.join(','));
    const byDomain = new Map<string, BenchmarkSample[]>();
    for (const s of raw) {
      const d = s.domain ?? 'unknown';
      if (!byDomain.has(d)) byDomain.set(d, []);
      const bucket = byDomain.get(d)!;
      if (bucket.length < perDomain) bucket.push(s);
    }
    let samples: BenchmarkSample[] = domains.flatMap((d) => byDomain.get(d) ?? []);
    if (hardLimit > 0) samples = samples.slice(0, hardLimit);
    logger.info(
      `CrossRE: ${samples.length} samples across ${domains.length} domains ` +
      `(${domains.map((d) => `${d}:${(byDomain.get(d) ?? []).length}`).join(' ')})`
    );

    const goldById = new Map(samples.map((s) => [s.id, s.groundTruth]));
    const domainById = new Map(samples.map((s) => [s.id, s.domain ?? 'unknown']));

    // ── Dump the sample list for the Python KGGen extractor (anti-desync) ──
    const samplesPath = path.join(cacheDir, 'samples.jsonl');
    fs.writeFileSync(
      samplesPath,
      samples.map((s) => JSON.stringify({ id: s.id, text: s.text, domain: s.domain })).join('\n') + '\n',
      'utf-8'
    );
    logger.info(`Dumped sample list -> ${samplesPath}`);

    // ── wanshi extraction (inline, cached, resumable) ──
    const wanshiPath = path.join(cacheDir, `wanshi.${opts.model.replace(/[/:.]/g, '_')}.jsonl`);
    const wanshiCache = loadJsonl<{ id: string; graph: KnowledgeGraph }>(wanshiPath);
    const systemPrompt = await promptManager.getSystemPrompt('benchmark', '**/*.txt', 'Benchmark evaluation');
    const wanshiGraphs = new Map<string, KnowledgeGraph>();
    for (const [id, rec] of wanshiCache) wanshiGraphs.set(id, rec.graph);

    let extracted = 0, excluded = 0;
    const todo = samples.filter((s) => !wanshiGraphs.has(s.id));
    logger.info(`wanshi: ${wanshiGraphs.size}/${samples.length} cached, extracting ${todo.length}`);
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      const failedBefore = kgBuilder.getFailedChunks().length;
      let kg: KnowledgeGraph = { entities: [], relations: [] };
      try {
        const graphs = await kgBuilder.build(textToProcessedFile(s.text, s.id), systemPrompt);
        if (graphs.length > 0) kg = graphs[0];
      } catch (err) {
        logger.warn(`wanshi ${s.id} threw: ${err}`);
      }
      // Transient/rate-limit failure -> exclude (don't cache; retried next run), matching BenchmarkRunner.
      if (kgBuilder.getFailedChunks().length > failedBefore) {
        excluded++;
        logger.warn(`wanshi ${s.id} extraction failed (rate-limit/transient) — excluded, will retry on re-run`);
        continue;
      }
      appendJsonl(wanshiPath, { id: s.id, graph: kg });
      wanshiGraphs.set(s.id, kg);
      extracted++;
      if ((i + 1) % 10 === 0 || i === todo.length - 1) {
        logger.info(`  wanshi ${i + 1}/${todo.length} (new=${extracted} excluded=${excluded})`);
      }
    }

    // ── KGGen graphs (from the Python cache, if present) ──
    const kggenPath = path.join(cacheDir, 'kggen.jsonl');
    const kggenRaw = loadJsonl<{ id: string; graph: any }>(kggenPath);
    const kggenGraphs = new Map<string, KnowledgeGraph>();
    for (const [id, rec] of kggenRaw) kggenGraphs.set(id, MineDataset.toGraph(rec.graph));
    const haveKggen = kggenGraphs.size > 0;

    // ── Scored set: samples both tools successfully processed (apples-to-apples) ──
    const wanshiIds = samples.filter((s) => wanshiGraphs.has(s.id)).map((s) => s.id);
    const scoredIds = haveKggen ? wanshiIds.filter((id) => kggenGraphs.has(id)) : wanshiIds;
    logger.info(
      `Scoring ${scoredIds.length} samples ` +
      `(wanshi ok=${wanshiIds.length}, kggen cached=${kggenGraphs.size}${haveKggen ? '' : ' — wanshi-only until python extractor runs'})`
    );

    const exactMatcher = new ExactMatcher();
    const semanticMatcher = new SemanticMatcher(embeddingService, threshold); // shared embedding cache across tools

    const wanshiScore = await scoreTool(scoredIds, wanshiGraphs, goldById, domainById, exactMatcher, semanticMatcher);
    const kggenScore = haveKggen
      ? await scoreTool(scoredIds, kggenGraphs, goldById, domainById, exactMatcher, semanticMatcher)
      : null;

    // ── Report ──
    const tools: [string, ToolScore][] = [['wanshi', wanshiScore]];
    if (kggenScore) tools.push(['kggen', kggenScore]);

    const lines: string[] = [];
    lines.push('');
    lines.push(`CrossRE two-way  model=${opts.model}  N=${scoredIds.length}  thr=${threshold}  prompt=${opts.promptVersion}`);
    lines.push('HEADLINE = node entity-capture (semantic): did the tool recover the gold entities (any node).');
    lines.push('end-* = entity/relation/triple over relation ENDPOINTS; rel/tri understate (abstract gold predicates).');
    lines.push('');
    lines.push(
      `${'tool'.padEnd(8)}${'nodeF1'.padStart(8)}${'nodeP'.padStart(8)}${'nodeR'.padStart(8)}` +
      `${'endEnt'.padStart(8)}${'endRel'.padStart(8)}${'endTri'.padStart(8)}${'tri/s'.padStart(7)}${'ent/s'.padStart(7)}`
    );
    lines.push('-'.repeat(69));
    for (const [name, sc] of tools) {
      lines.push(
        `${name.padEnd(8)}` +
        `${f3(sc.nodeEntitySem.f1).padStart(8)}` +
        `${f3(sc.nodeEntitySem.precision).padStart(8)}` +
        `${f3(sc.nodeEntitySem.recall).padStart(8)}` +
        `${f3(sc.tripletSem.entity.f1).padStart(8)}` +
        `${f3(sc.tripletSem.relation.f1).padStart(8)}` +
        `${f3(sc.tripletSem.triple.f1).padStart(8)}` +
        `${sc.triplesPer.toFixed(1).padStart(7)}` +
        `${sc.entsPer.toFixed(1).padStart(7)}`
      );
    }
    lines.push('');
    lines.push('Per-domain node entity-capture F1 (semantic):');
    lines.push(`${'domain'.padEnd(12)}${tools.map(([n]) => n.padStart(10)).join('')}`);
    lines.push('-'.repeat(12 + tools.length * 10));
    for (const d of domains) {
      const cells = tools.map(([, sc]) => {
        const m = sc.perDomainNode.get(d);
        return (m ? f3(m.f1) : '—').padStart(10);
      });
      lines.push(`${d.padEnd(12)}${cells.join('')}`);
    }
    lines.push('');
    if (!haveKggen) {
      lines.push('NOTE: KGGen cache empty — run scripts/kggen-crossre.py then re-run this for the two-way table.');
      lines.push('');
    }
    console.log(lines.join('\n'));

    const report = {
      dataset: 'crossre',
      model: opts.model,
      promptVersion: opts.promptVersion,
      matchThreshold: threshold,
      domains,
      perDomainCap: perDomain,
      scoredCount: scoredIds.length,
      wanshiOk: wanshiIds.length,
      wanshiExcluded: excluded,
      kggenCached: kggenGraphs.size,
      tools: Object.fromEntries(tools.map(([name, sc]) => [name, {
        nodeEntityCapture: { semantic: sc.nodeEntitySem, exact: sc.nodeEntityExact },
        tripletEndpoint: { semantic: sc.tripletSem, exact: sc.tripletExact },
        perDomainNodeSemantic: Object.fromEntries(sc.perDomainNode),
        triplesPerSample: sc.triplesPer,
        entitiesPerSample: sc.entsPer,
      }])),
    };
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(`Saved two-way report -> ${output}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
