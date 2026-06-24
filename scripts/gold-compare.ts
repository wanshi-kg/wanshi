#!/usr/bin/env ts-node
/**
 * Gold-labeled two-way comparison: wanshi vs KGGen, SAME model, across the gold
 * benchmarks — CrossRE (sentence, 6 domains), SemEval-2010 T8 (sentence), Re-DocRED
 * (document-level, Wikidata schema + Ign-F1). The complement to MINE (recall-only,
 * judge-mediated): these carry the load-bearing precision-aware F1 claims.
 *
 * Supersedes scripts/crossre-compare.ts (which only did CrossRE). The scoring core
 * is shared via src/evaluation/compare/goldCompare.ts so every dataset is scored
 * identically. KGGen is run separately (scripts/kggen-crossre.py, dataset-agnostic
 * via --samples/--out) and cached; both tools read the SAME dumped sample list
 * (the anti-desync guard that bit us on the MINE mirror).
 *
 * Extraction modes (wanshi side; KGGen is always its own free-predicate extraction):
 *   default  closed base vocab (v5)            — the canonical production posture
 *   --open-predicate                            — drop the closed enum → free predicates (H3 / canon-tax)
 *   --relation-vocab <csv|@file>                — feed a KNOWN closed relation schema (H4)
 *
 * Run order (idempotent / resumable), e.g. SemEval:
 *   1) npx ts-node scripts/gold-compare.ts --dataset semeval --model deepseek/deepseek-v4-pro --limit 300
 *        -> dumps samples.jsonl + extracts/caches wanshi + prints wanshi-only table
 *   2) .venv-kggen/bin/python scripts/kggen-crossre.py --model deepseek/deepseek-v4-pro \
 *        --samples data/semeval/compare/samples.jsonl --out data/semeval/compare/kggen.jsonl
 *   3) re-run (1) -> wanshi from cache + KGGen from cache -> full two-way table
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
import { CorpusGlossary } from '../src/types/CorpusProfile';
import {
  CrossREDataset,
  SemEval2010Dataset,
  RedocredDataset,
  ExactMatcher,
  SemanticMatcher,
  MineDataset,
} from '../src/evaluation';
import { BenchmarkSample, Triplet } from '../src/evaluation/datasets/IDataset';
import { scoreGraph, ToolScore, tripleKey, loadJsonl, appendJsonl } from '../src/evaluation/compare/goldCompare';

const CROSSRE_DOMAINS = ['ai', 'literature', 'music', 'news', 'politics', 'science'];

interface DatasetSpec {
  defaultDataPath: string;
  hasDomains: boolean;
  hasIgnF1: boolean;        // Re-DocRED: exclude train-seen triples
  trainPath?: string;
}
const DATASETS: Record<string, DatasetSpec> = {
  crossre:  { defaultDataPath: 'data/crossre/crossre_data',     hasDomains: true,  hasIgnF1: false },
  semeval:  { defaultDataPath: 'data/semeval/test.jsonl',       hasDomains: false, hasIgnF1: false },
  redocred: { defaultDataPath: 'data/redocred/test_revised.json', hasDomains: false, hasIgnF1: true,
              trainPath: 'data/redocred/train_revised.json' },
};

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
  promptVersion: string; openPredicate: boolean; strictVocabulary: boolean;
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
    pipeline: { extraction: { openPredicate: opts.openPredicate, strictVocabulary: opts.strictVocabulary } },
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

/** Parse --relation-vocab: "a,b,c" or "@/path/to/file" (one predicate per line). */
function parseRelationVocab(raw: string): string[] {
  if (raw.startsWith('@')) {
    return fs.readFileSync(raw.slice(1), 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const f3 = (n: number) => n.toFixed(3);

async function loadSamples(
  dataset: string, dataPath: string, domains: string[], perDomain: number, hardLimit: number, logger: Logger,
): Promise<BenchmarkSample[]> {
  if (dataset === 'crossre') {
    const raw = await new CrossREDataset().load(dataPath, Number.MAX_SAFE_INTEGER, domains.join(','));
    const byDomain = new Map<string, BenchmarkSample[]>();
    for (const s of raw) {
      const d = s.domain ?? 'unknown';
      if (!byDomain.has(d)) byDomain.set(d, []);
      const bucket = byDomain.get(d)!;
      if (bucket.length < perDomain) bucket.push(s);
    }
    let samples = domains.flatMap((d) => byDomain.get(d) ?? []);
    if (hardLimit > 0) samples = samples.slice(0, hardLimit);
    logger.info(`crossre: ${samples.length} samples (${domains.map((d) => `${d}:${(byDomain.get(d) ?? []).length}`).join(' ')})`);
    return samples;
  }
  const limit = hardLimit > 0 ? hardLimit : Number.MAX_SAFE_INTEGER;
  const loader = dataset === 'semeval' ? new SemEval2010Dataset() : new RedocredDataset();
  const samples = await loader.load(dataPath, limit);
  logger.info(`${dataset}: ${samples.length} samples loaded from ${dataPath}`);
  return samples;
}

/** Re-DocRED Ign-F1: (subj|pred|obj) keys of every triple in the training split. */
async function loadTrainIgnoreKeys(trainPath: string, logger: Logger): Promise<Set<string>> {
  const train = await new RedocredDataset().load(trainPath, Number.MAX_SAFE_INTEGER);
  const keys = new Set<string>();
  for (const s of train) for (const t of s.groundTruth) keys.add(tripleKey(t));
  logger.info(`Ign-F1: ${keys.size} unique train-seen triples loaded from ${trainPath}`);
  return keys;
}

const program = new Command('gold-compare');
program
  .description('Gold-labeled two-way: wanshi vs KGGen (same model) on crossre | semeval | redocred')
  .requiredOption('--dataset <name>', 'crossre | semeval | redocred')
  .option('--model <name>', 'Model id (same for both tools)', 'deepseek/deepseek-v4-pro')
  .option('--provider <name>', 'Generation provider: ollama | openai', 'openai')
  .option('--host <url>', 'OpenAI-compatible base URL', 'https://openrouter.ai/api/v1')
  .option('--api-key <key>', 'API key (else $OPENAI_API_KEY / .env)')
  .option('--data-path <path>', 'Dataset path (defaults per dataset)')
  .option('--domains <list>', 'CrossRE domains (comma-separated)', CROSSRE_DOMAINS.join(','))
  .option('--per-domain <n>', 'CrossRE: max usable samples per domain', '50')
  .option('--limit <n>', 'Total sample cap (semeval/redocred; 0 = all)', '300')
  .option('--open-predicate', 'Drop the closed enum → free predicates (H3 / canon-tax)', false)
  .option('--relation-vocab <csv|@file>', 'Feed a known closed relation schema (H4)')
  .option('--embeddings-provider <n>', 'Embeddings provider', 'ollama')
  .option('--embeddings-model <name>', 'Embedding model (local & free)', 'nomic-embed-text')
  .option('--embeddings-host <url>', 'Embeddings host', 'http://localhost:11434')
  .option('--match-threshold <n>', 'Semantic match threshold', '0.80')
  .option('--prompt-version <ver>', 'wanshi prompt version', 'v5')
  .option('--cache-dir <dir>', 'Cache dir (defaults data/<dataset>/compare)')
  .option('--output <path>', 'Two-way JSON report path')
  .action(async (opts) => {
    loadDotEnv();
    const dataset = opts.dataset as string;
    const spec = DATASETS[dataset];
    if (!spec) { console.error(`Unknown dataset: ${dataset}. Use crossre | semeval | redocred.`); process.exit(1); }

    const perDomain = parseInt(opts.perDomain, 10) || 50;
    const hardLimit = parseInt(opts.limit, 10) || 0;
    const threshold = parseFloat(opts.matchThreshold);
    const domains = (opts.domains as string).split(',').map((s) => s.trim()).filter(Boolean);
    const dataPath = (opts.dataPath as string) || spec.defaultDataPath;
    const cacheDir = (opts.cacheDir as string) || `data/${dataset}/compare`;
    const openPredicate = !!opts.openPredicate;
    const relationVocab = opts.relationVocab ? parseRelationVocab(opts.relationVocab as string) : null;
    if (openPredicate && relationVocab) {
      console.error('--open-predicate and --relation-vocab are mutually exclusive.'); process.exit(1);
    }
    const mode = openPredicate ? 'open' : relationVocab ? 'vocab' : 'closed';
    const modeSuffix = mode === 'closed' ? '' : `.${mode}`;
    const modelSlug = (opts.model as string).replace(/[/:.]/g, '_');
    const output = (opts.output as string) ||
      `results/${dataset}/${modelSlug}__${mode}__wanshi-vs-kggen.json`;

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.dirname(output), { recursive: true });

    // Closed relation schema (H4): a CorpusGlossary the model + Zod enum both honor.
    const glossary: CorpusGlossary | undefined = relationVocab
      ? { entityNames: [], entityTypes: [], relationTypes: relationVocab }
      : undefined;

    const processingOptions = buildProcessingOptions({
      provider: opts.provider, model: opts.model, host: opts.host,
      apiKey: opts.apiKey || process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY,
      embeddingsProvider: opts.embeddingsProvider, embeddingsModel: opts.embeddingsModel,
      embeddingsHost: opts.embeddingsHost, promptVersion: opts.promptVersion, openPredicate,
      // A supplied closed schema (H4) is STRICT — exactly those predicates, base NOT unioned.
      strictVocabulary: !!relationVocab,
    });
    const container = ContainerFactory.createContainer({ processingOptions });
    const logger = await container.resolve<Logger>(TYPES.Logger);
    const kgBuilder = await container.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
    const promptManager = (await container.resolve(TYPES.PromptManager)) as PromptManager;
    const embeddingService = await container.resolve<EmbeddingService>(TYPES.EmbeddingService);

    logger.info(`gold-compare dataset=${dataset} model=${opts.model} mode=${mode}` +
      (glossary ? ` vocab=${relationVocab!.length} predicates` : ''));

    // ── Load samples ──
    const samples = await loadSamples(dataset, dataPath, domains, perDomain, hardLimit, logger);
    const goldById = new Map(samples.map((s) => [s.id, s.groundTruth]));
    const domainById = spec.hasDomains ? new Map(samples.map((s) => [s.id, s.domain ?? 'unknown'])) : undefined;
    const ignoreKeys = spec.hasIgnF1 && spec.trainPath ? await loadTrainIgnoreKeys(spec.trainPath, logger) : undefined;

    // ── Dump the sample list for the Python KGGen extractor (anti-desync) ──
    const samplesPath = path.join(cacheDir, 'samples.jsonl');
    fs.writeFileSync(
      samplesPath,
      samples.map((s) => JSON.stringify({ id: s.id, text: s.text, domain: s.domain })).join('\n') + '\n',
      'utf-8',
    );
    logger.info(`Dumped sample list -> ${samplesPath}`);

    // ── wanshi extraction (inline, cached, resumable; mode-suffixed so modes don't collide) ──
    const wanshiPath = path.join(cacheDir, `wanshi.${modelSlug}${modeSuffix}.jsonl`);
    const wanshiCache = loadJsonl<{ id: string; graph: KnowledgeGraph }>(wanshiPath, fs);
    // Closed → base vocab; open → free predicates; vocab → the supplied closed schema (both prompt + enum).
    const systemPrompt = await promptManager.getSystemPrompt(
      'benchmark', '**/*.txt', 'Benchmark evaluation', undefined, glossary, openPredicate,
    );
    const wanshiGraphs = new Map<string, KnowledgeGraph>();
    for (const [id, rec] of wanshiCache) wanshiGraphs.set(id, rec.graph);

    let extracted = 0, excluded = 0;
    const todo = samples.filter((s) => !wanshiGraphs.has(s.id));
    logger.info(`wanshi[${mode}]: ${wanshiGraphs.size}/${samples.length} cached, extracting ${todo.length}`);
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      const failedBefore = kgBuilder.getFailedChunks().length;
      let kg: KnowledgeGraph = { entities: [], relations: [] };
      try {
        const graphs = await kgBuilder.build(textToProcessedFile(s.text, s.id), systemPrompt, undefined, glossary);
        if (graphs.length > 0) kg = graphs[0];
      } catch (err) {
        logger.warn(`wanshi ${s.id} threw: ${err}`);
      }
      // Transient/rate-limit failure -> exclude (don't cache; retried next run).
      if (kgBuilder.getFailedChunks().length > failedBefore) {
        excluded++;
        logger.warn(`wanshi ${s.id} extraction failed (rate-limit/transient) — excluded, will retry on re-run`);
        continue;
      }
      appendJsonl(wanshiPath, { id: s.id, graph: kg }, fs);
      wanshiGraphs.set(s.id, kg);
      extracted++;
      if ((i + 1) % 20 === 0 || i === todo.length - 1) {
        logger.info(`  wanshi ${i + 1}/${todo.length} (new=${extracted} excluded=${excluded})`);
      }
    }

    // ── KGGen graphs (from the Python cache, if present) ──
    const kggenPath = path.join(cacheDir, 'kggen.jsonl');
    const kggenRaw = loadJsonl<{ id: string; graph: any }>(kggenPath, fs);
    const kggenGraphs = new Map<string, KnowledgeGraph>();
    for (const [id, rec] of kggenRaw) kggenGraphs.set(id, MineDataset.toGraph(rec.graph));
    const haveKggen = kggenGraphs.size > 0;

    // ── Scored set: samples both tools successfully processed (apples-to-apples) ──
    const wanshiIds = samples.filter((s) => wanshiGraphs.has(s.id)).map((s) => s.id);
    const scoredIds = haveKggen ? wanshiIds.filter((id) => kggenGraphs.has(id)) : wanshiIds;
    logger.info(
      `Scoring ${scoredIds.length} samples ` +
      `(wanshi ok=${wanshiIds.length}, kggen cached=${kggenGraphs.size}${haveKggen ? '' : ' — wanshi-only until python extractor runs'})`,
    );

    const exactMatcher = new ExactMatcher();
    const semanticMatcher = new SemanticMatcher(embeddingService, threshold); // shared embedding cache across tools

    const scoreOpts = { domainById, ignoreKeys };
    const wanshiScore = await scoreGraph(scoredIds, wanshiGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts);
    const kggenScore = haveKggen
      ? await scoreGraph(scoredIds, kggenGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts)
      : null;

    // ── Report ──
    const tools: [string, ToolScore][] = [['wanshi', wanshiScore]];
    if (kggenScore) tools.push(['kggen', kggenScore]);

    const lines: string[] = [];
    lines.push('');
    lines.push(`${dataset} two-way  model=${opts.model}  mode=${mode}  N=${scoredIds.length}  thr=${threshold}  prompt=${opts.promptVersion}`);
    lines.push('HEADLINE = node entity-capture (semantic): did the tool recover the gold entities (any node).');
    lines.push('end-* = entity/relation/triple over relation ENDPOINTS; rel/tri understate (abstract gold predicates).');
    if (ignoreKeys) lines.push('ignTri = triple F1 with train-seen triples excluded (Re-DocRED Ign-F1).');
    lines.push('');
    const header =
      `${'tool'.padEnd(8)}${'nodeF1'.padStart(8)}${'nodeP'.padStart(8)}${'nodeR'.padStart(8)}` +
      `${'endEnt'.padStart(8)}${'endRel'.padStart(8)}${'endTri'.padStart(8)}` +
      (ignoreKeys ? `${'ignTri'.padStart(8)}` : '') +
      `${'tri/s'.padStart(7)}${'ent/s'.padStart(7)}`;
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const [name, sc] of tools) {
      lines.push(
        `${name.padEnd(8)}` +
        `${f3(sc.nodeEntitySem.f1).padStart(8)}` +
        `${f3(sc.nodeEntitySem.precision).padStart(8)}` +
        `${f3(sc.nodeEntitySem.recall).padStart(8)}` +
        `${f3(sc.tripletSem.entity.f1).padStart(8)}` +
        `${f3(sc.tripletSem.relation.f1).padStart(8)}` +
        `${f3(sc.tripletSem.triple.f1).padStart(8)}` +
        (ignoreKeys ? `${f3(sc.ignTripletSem?.triple.f1 ?? 0).padStart(8)}` : '') +
        `${sc.triplesPer.toFixed(1).padStart(7)}` +
        `${sc.entsPer.toFixed(1).padStart(7)}`,
      );
    }
    if (domainById) {
      lines.push('');
      lines.push('Per-domain node entity-capture F1 (semantic):');
      lines.push(`${'domain'.padEnd(12)}${tools.map(([n]) => n.padStart(10)).join('')}`);
      lines.push('-'.repeat(12 + tools.length * 10));
      for (const d of domains) {
        const cells = tools.map(([, sc]) => {
          const m = sc.perDomainNode?.get(d);
          return (m ? f3(m.f1) : '—').padStart(10);
        });
        lines.push(`${d.padEnd(12)}${cells.join('')}`);
      }
    }
    lines.push('');
    if (!haveKggen) {
      lines.push(`NOTE: KGGen cache empty — run scripts/kggen-crossre.py --samples ${samplesPath} --out ${kggenPath} then re-run for the two-way table.`);
      lines.push('');
    }
    console.log(lines.join('\n'));

    const report = {
      dataset,
      mode,
      model: opts.model,
      promptVersion: opts.promptVersion,
      matchThreshold: threshold,
      ...(domainById ? { domains, perDomainCap: perDomain } : {}),
      ...(relationVocab ? { relationVocab } : {}),
      scoredCount: scoredIds.length,
      wanshiOk: wanshiIds.length,
      wanshiExcluded: excluded,
      kggenCached: kggenGraphs.size,
      tools: Object.fromEntries(tools.map(([name, sc]) => [name, {
        nodeEntityCapture: { semantic: sc.nodeEntitySem, exact: sc.nodeEntityExact },
        tripletEndpoint: { semantic: sc.tripletSem, exact: sc.tripletExact },
        ...(ignoreKeys ? { ignTriplet: { semantic: sc.ignTripletSem, exact: sc.ignTripletExact } } : {}),
        ...(sc.perDomainNode ? { perDomainNodeSemantic: Object.fromEntries(sc.perDomainNode) } : {}),
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
