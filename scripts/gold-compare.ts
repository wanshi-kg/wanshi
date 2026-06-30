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
import { ILLMProvider } from '../src/types/ILLMProvider';
import { CorpusGlossary } from '../src/types/CorpusProfile';
import {
  CrossREDataset,
  SemEval2010Dataset,
  RedocredDataset,
  BioREDDataset,
  SciERDataset,
  DrugProtDataset,
  FinREDDataset,
  CodeDataset,
  ExactMatcher,
  SemanticMatcher,
  MineDataset,
} from '../src/evaluation';
import { BenchmarkSample, IDatasetLoader, Triplet } from '../src/evaluation/datasets/IDataset';
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
  // Domain corpus-sourcing lane — gold-labeled, document/sentence/file level. Each ships
  // a data/<ds>/relations.vocab for the H4 closed-schema mode (--relation-vocab @file).
  biored:   { defaultDataPath: 'data/biored/BioRED/Test.BioC.JSON',                          hasDomains: false, hasIgnF1: false },
  scier:    { defaultDataPath: 'data/scier/test.jsonl',                                       hasDomains: false, hasIgnF1: false },
  drugprot: { defaultDataPath: 'data/drugprot/drugprot-gs-training-development/development',  hasDomains: false, hasIgnF1: false },
  finred:   { defaultDataPath: 'data/finred/test.jsonl',                                      hasDomains: false, hasIgnF1: false },
  code:     { defaultDataPath: 'data/code/flask',                                             hasDomains: false, hasIgnF1: false },
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
  maxTokens?: number; contextLength?: number;
  /** wanshi-full arm: enable the post-extraction grounding gate (the precision lever). */
  grounding?: 'disabled' | 'flag' | 'drop';
}): ProcessingOptions {
  return parseConfig({
    input: 'benchmark',
    filter: ['**/*.txt'],
    output: 'benchmark-kg.json',
    description: 'Benchmark evaluation',
    llm: {
      provider: opts.provider, model: opts.model, host: opts.host,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      temperature: 0, repeatPenalty: 1.1, contextLength: opts.contextLength ?? 8192, seed: 42,
      promptVersion: opts.promptVersion,
      // Guardrail: cap output tokens so a model that degenerates into runaway
      // repetition truncates fast instead of generating to its 32k/64k ceiling
      // (a ~10-min hang per doc). jsonrepair still salvages the partial graph.
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    },
    embeddings: {
      provider: opts.embeddingsProvider, model: opts.embeddingsModel, host: opts.embeddingsHost,
      ...(opts.apiKey && opts.embeddingsProvider === 'openai' ? { apiKey: opts.apiKey } : {}),
    },
    chunking: { mode: 'disabled' },
    retrieval: { mode: 'disabled' },
    corpus: { profiling: 'disabled' },
    grounding: { mode: opts.grounding ?? 'disabled' },
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
const round = (n: number, d = 1) => { const p = 10 ** d; return Math.round(n * p) / p; };
const signed = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(3);

/**
 * Run one extraction arm (plain `build()` → graphs[0]), cached/resumable. Mirrors the inline
 * lean-wanshi loop; used by the vanilla baseline (and any same-shape arm). The pipeline-less
 * config + the shared `toGraph` output guarantee the vanilla graph is scored through the
 * identical path as wanshi (Dove's fairness gate #2).
 */
async function extractArm(params: {
  samples: BenchmarkSample[]; cachePath: string; kgBuilder: KnowledgeGraphBuilder;
  systemPrompt: string; glossary: CorpusGlossary | undefined; llmService: ILLMProvider;
  logger: Logger; label: string;
}): Promise<{ graphs: Map<string, KnowledgeGraph>; extracted: number; excluded: number; seconds: number; promptTok: number; completionTok: number; failedChunks: number }> {
  const { samples, cachePath, kgBuilder, systemPrompt, glossary, llmService, logger, label } = params;
  const graphs = new Map<string, KnowledgeGraph>();
  for (const [id, rec] of loadJsonl<{ id: string; graph: KnowledgeGraph }>(cachePath, fs)) graphs.set(id, rec.graph);
  let extracted = 0, excluded = 0, promptTok = 0, completionTok = 0;
  const start = Date.now();
  const todo = samples.filter((s) => !graphs.has(s.id));
  logger.info(`${label}: ${graphs.size}/${samples.length} cached, extracting ${todo.length}`);
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i];
    const failedBefore = kgBuilder.getFailedChunks().length;
    let kg: KnowledgeGraph = { entities: [], relations: [] };
    try {
      const gs = await kgBuilder.build(textToProcessedFile(s.text, s.id), systemPrompt, undefined, glossary);
      if (gs.length > 0) kg = gs[0];
    } catch (err) {
      logger.warn(`${label} ${s.id} threw: ${err}`);
    }
    if (kgBuilder.getFailedChunks().length > failedBefore) {
      excluded++;
      logger.warn(`${label} ${s.id} extraction failed (transient) — excluded, will retry`);
      continue;
    }
    appendJsonl(cachePath, { id: s.id, graph: kg }, fs);
    graphs.set(s.id, kg);
    const u = llmService.getLastUsage?.();
    if (u) { promptTok += u.promptTokens ?? 0; completionTok += u.completionTokens ?? 0; }
    extracted++;
    if ((i + 1) % 20 === 0 || i === todo.length - 1) logger.info(`  ${label} ${i + 1}/${todo.length} (new=${extracted} excluded=${excluded})`);
  }
  return { graphs, extracted, excluded, seconds: (Date.now() - start) / 1000, promptTok, completionTok, failedChunks: kgBuilder.getFailedChunks().length };
}

/** Build the extraction-stats sidecar for an arm (conformance + throughput); reuse on re-score. */
function assembleArmStats(
  r: { extracted: number; excluded: number; seconds: number; promptTok: number; completionTok: number; failedChunks: number },
  statsPath: string,
): any {
  if (r.extracted <= 0) return fs.existsSync(statsPath) ? JSON.parse(fs.readFileSync(statsPath, 'utf-8')) : null;
  const attempted = r.extracted + r.excluded;
  const stats = {
    attempted, extracted: r.extracted, excluded: r.excluded, failedChunks: r.failedChunks,
    conformanceRate: attempted > 0 ? round(r.extracted / attempted, 3) : null,
    seconds: round(r.seconds, 1), completionTokens: r.completionTok, promptTokens: r.promptTok,
    completionTokensPerSec: r.seconds > 0 && r.completionTok > 0 ? round(r.completionTok / r.seconds, 1) : null,
    note: 'tokens = last chunk per sample (exact for single-chunk corpora); throughput is rental != M4',
  };
  fs.writeFileSync(statsPath, JSON.stringify(stats), 'utf-8');
  return stats;
}

/**
 * related_to-share (H5 collapse signal): fraction of a tool's relations typed as the
 * `related_to` escape predicate. Meaningful for wanshi (closed vocab → related_to is the
 * catch-all); high share = the model couldn't commit to a typed predicate. Tolerates both
 * string[] and bare-string relationType.
 */
function relatedToShare(graphs: Map<string, KnowledgeGraph>, ids: string[]): { relations: number; relatedTo: number; share: number } {
  let relations = 0, relatedTo = 0;
  for (const id of ids) {
    const g = graphs.get(id);
    if (!g) continue;
    for (const r of g.relations) {
      relations++;
      const types = Array.isArray(r.relationType) ? r.relationType : [r.relationType];
      if (types.some((t) => String(t).toLowerCase() === 'related_to')) relatedTo++;
    }
  }
  return { relations, relatedTo, share: relations ? round(relatedTo / relations, 3) : 0 };
}

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
  const loaders: Record<string, IDatasetLoader> = {
    semeval: new SemEval2010Dataset(),
    redocred: new RedocredDataset(),
    biored: new BioREDDataset(),
    scier: new SciERDataset(),
    drugprot: new DrugProtDataset(),
    finred: new FinREDDataset(),
    code: new CodeDataset(),
  };
  const loader = loaders[dataset];
  if (!loader) throw new Error(`No loader registered for dataset '${dataset}'`);
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
  .description('Gold-labeled two-way: wanshi vs KGGen (same model) on crossre | semeval | redocred | biored | scier | drugprot | finred | code')
  .requiredOption('--dataset <name>', 'crossre | semeval | redocred | biored | scier | drugprot | finred | code')
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
  .option('--max-tokens <n>', 'Cap output tokens — guardrail against runaway generation', '8192')
  .option('--ctx <n>', 'Model context length (Ollama num_ctx) — raise for verbose/reasoning models', '8192')
  .option('--cache-dir <dir>', 'Cache dir (defaults data/<dataset>/compare)')
  .option('--output <path>', 'Two-way JSON report path')
  .option('--vanilla', 'Add a vanilla-baseline arm: plain prompt, SAME closed vocab + schema, no pipeline (the prompt-engineering ablation)', false)
  .option('--full', 'Add a full-pipeline arm: same v5 extraction + grounding(drop) + merge (the pipeline ablation; AST seed excluded — it IS the code gold)', false)
  .action(async (opts) => {
    loadDotEnv();
    const dataset = opts.dataset as string;
    const spec = DATASETS[dataset];
    if (!spec) { console.error(`Unknown dataset: ${dataset}. Use one of: ${Object.keys(DATASETS).join(' | ')}.`); process.exit(1); }

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

    const optArgs = {
      provider: opts.provider, model: opts.model, host: opts.host,
      apiKey: opts.apiKey || process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY,
      embeddingsProvider: opts.embeddingsProvider, embeddingsModel: opts.embeddingsModel,
      embeddingsHost: opts.embeddingsHost, promptVersion: opts.promptVersion, openPredicate,
      // A supplied closed schema (H4) is STRICT — exactly those predicates, base NOT unioned.
      strictVocabulary: !!relationVocab,
      maxTokens: parseInt(opts.maxTokens, 10) || undefined,
      contextLength: parseInt(opts.ctx, 10) || undefined,
    };
    const processingOptions = buildProcessingOptions(optArgs);
    const container = ContainerFactory.createContainer({ processingOptions });
    const logger = await container.resolve<Logger>(TYPES.Logger);
    const kgBuilder = await container.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
    const promptManager = (await container.resolve(TYPES.PromptManager)) as PromptManager;
    const embeddingService = await container.resolve<EmbeddingService>(TYPES.EmbeddingService);
    const llmService = await container.resolve<ILLMProvider>(TYPES.LLMService); // getLastUsage() seam → throughput

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
    let genPromptTok = 0, genCompletionTok = 0;
    const extractStart = Date.now();
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
      const u = llmService.getLastUsage?.(); // last chunk's usage (exact for single-chunk corpora)
      if (u) { genPromptTok += u.promptTokens ?? 0; genCompletionTok += u.completionTokens ?? 0; }
      extracted++;
      if ((i + 1) % 20 === 0 || i === todo.length - 1) {
        logger.info(`  wanshi ${i + 1}/${todo.length} (new=${extracted} excluded=${excluded})`);
      }
    }

    // ── Extraction stats (wanshi-side, run-level): conformance + throughput. Persisted to a
    //    sidecar so the step-3 re-score (wanshi fully cached → extracted=0) keeps the numbers. ──
    const extractSeconds = (Date.now() - extractStart) / 1000;
    const statsPath = path.join(cacheDir, `wanshi.${modelSlug}${modeSuffix}.stats.json`);
    let extractionStats: any;
    if (extracted > 0) {
      const attempted = extracted + excluded;
      extractionStats = {
        attempted, extracted, excluded,
        failedChunks: kgBuilder.getFailedChunks().length,
        // local Ollama has no rate limits → an excluded sample is a JSON-conformance failure
        conformanceRate: attempted > 0 ? round(extracted / attempted, 3) : null,
        seconds: round(extractSeconds, 1),
        completionTokens: genCompletionTok,
        promptTokens: genPromptTok,
        completionTokensPerSec: extractSeconds > 0 && genCompletionTok > 0 ? round(genCompletionTok / extractSeconds, 1) : null,
        note: 'tokens = last chunk per sample (exact for single-chunk corpora; undercounts multi-chunk docs); throughput is rental != M4',
      };
      fs.writeFileSync(statsPath, JSON.stringify(extractionStats), 'utf-8');
    } else if (fs.existsSync(statsPath)) {
      extractionStats = JSON.parse(fs.readFileSync(statsPath, 'utf-8')); // re-score run: reuse step-1 stats
    } else {
      extractionStats = null;
    }

    // ── vanilla baseline arm (opt-in): plain prompt, SAME closed vocab + schema, no pipeline.
    //    `wanshi − vanilla` = the v5 prompt's marginal value (the prompt-engineering ablation).
    //    Same `build()`/`toGraph` path + same `glossary` (→ same Zod enum) ⇒ Dove's fairness
    //    gates: vanilla HAS the vocab (gate #1) and is scored identically (gate #2). ──
    let vanillaGraphs: Map<string, KnowledgeGraph> | null = null;
    let vanillaStats: any = null;
    if (opts.vanilla) {
      const vContainer = ContainerFactory.createContainer({
        processingOptions: buildProcessingOptions({ ...optArgs, promptVersion: 'vanilla' }),
      });
      const vBuilder = await vContainer.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
      const vPM = await vContainer.resolve<PromptManager>(TYPES.PromptManager);
      const vLlm = await vContainer.resolve<ILLMProvider>(TYPES.LLMService);
      const vSystemPrompt = await vPM.getSystemPrompt('benchmark', '**/*.txt', 'Benchmark evaluation', undefined, glossary, openPredicate);
      const r = await extractArm({
        samples, cachePath: path.join(cacheDir, `vanilla.${modelSlug}${modeSuffix}.jsonl`),
        kgBuilder: vBuilder, systemPrompt: vSystemPrompt, glossary, llmService: vLlm, logger, label: `vanilla[${mode}]`,
      });
      vanillaGraphs = r.graphs;
      vanillaStats = assembleArmStats(r, path.join(cacheDir, `vanilla.${modelSlug}${modeSuffix}.stats.json`));
    }

    // ── wanshi-full arm (opt-in): the v5 extraction + grounding(drop) + merge.
    //    `wanshi-full − wanshi` = the pipeline's marginal value (the pipeline ablation).
    //    The AST seed is DELIBERATELY excluded: the code gold IS the outlion AST, so seeding it
    //    is circular (the bench scores seed-off by design); retrieval / cross-file merge /
    //    corpus glossary are structurally inert on independently-scored single docs. So the
    //    measurable, non-circular "pipeline" here = the grounding gate (precision lever) +
    //    within-graph merge dedup. Deterministic (seed 42, temp 0) ⇒ the extraction matches the
    //    lean arm; grounding+merge are what differ. ──
    let fullGraphs: Map<string, KnowledgeGraph> | null = null;
    if (opts.full) {
      const fContainer = ContainerFactory.createContainer({
        processingOptions: buildProcessingOptions({ ...optArgs, grounding: 'drop' }),
      });
      const fBuilder = await fContainer.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
      const fPM = await fContainer.resolve<PromptManager>(TYPES.PromptManager);
      const merger = await fContainer.resolve<{ merge(g: KnowledgeGraph[], ext?: Set<string>): Promise<KnowledgeGraph> }>(TYPES.KnowledgeGraphMerger);
      const fSystemPrompt = await fPM.getSystemPrompt('benchmark', '**/*.txt', 'Benchmark evaluation', undefined, glossary, openPredicate);
      const fullPath = path.join(cacheDir, `wanshi-full.${modelSlug}${modeSuffix}.jsonl`);
      fullGraphs = new Map<string, KnowledgeGraph>();
      for (const [id, rec] of loadJsonl<{ id: string; graph: KnowledgeGraph }>(fullPath, fs)) fullGraphs.set(id, rec.graph);
      const fTodo = samples.filter((s) => !fullGraphs!.has(s.id));
      logger.info(`wanshi-full[${mode}]: ${fullGraphs.size}/${samples.length} cached, extracting ${fTodo.length} (grounding=drop + merge)`);
      for (let i = 0; i < fTodo.length; i++) {
        const s = fTodo[i];
        const failedBefore = fBuilder.getFailedChunks().length;
        let kg: KnowledgeGraph = { entities: [], relations: [] };
        try {
          const gs = await fBuilder.build(textToProcessedFile(s.text, s.id), fSystemPrompt, undefined, glossary);
          if (gs.length > 0) kg = await merger.merge(gs, new Set<string>());
        } catch (err) {
          logger.warn(`wanshi-full ${s.id} threw: ${err}`);
        }
        if (fBuilder.getFailedChunks().length > failedBefore) { logger.warn(`wanshi-full ${s.id} excluded`); continue; }
        appendJsonl(fullPath, { id: s.id, graph: kg }, fs);
        fullGraphs.set(s.id, kg);
        if ((i + 1) % 20 === 0 || i === fTodo.length - 1) logger.info(`  wanshi-full ${i + 1}/${fTodo.length}`);
      }
    }

    // ── KGGen graphs (from the Python cache, if present) ──
    const kggenPath = path.join(cacheDir, 'kggen.jsonl');
    const kggenRaw = loadJsonl<{ id: string; graph: any }>(kggenPath, fs);
    const kggenGraphs = new Map<string, KnowledgeGraph>();
    for (const [id, rec] of kggenRaw) kggenGraphs.set(id, MineDataset.toGraph(rec.graph));
    const haveKggen = kggenGraphs.size > 0;

    // ── Scored set: samples EVERY active arm produced (apples-to-apples across all columns) ──
    const wanshiIds = samples.filter((s) => wanshiGraphs.has(s.id)).map((s) => s.id);
    let scoredIds = haveKggen ? wanshiIds.filter((id) => kggenGraphs.has(id)) : wanshiIds;
    if (vanillaGraphs) scoredIds = scoredIds.filter((id) => vanillaGraphs!.has(id));
    if (fullGraphs) scoredIds = scoredIds.filter((id) => fullGraphs!.has(id));
    logger.info(
      `Scoring ${scoredIds.length} samples (wanshi ok=${wanshiIds.length}` +
      (vanillaGraphs ? `, vanilla=${vanillaGraphs.size}` : '') +
      (fullGraphs ? `, full=${fullGraphs.size}` : '') +
      `, kggen cached=${kggenGraphs.size}${haveKggen ? '' : ' — kggen column absent until the python extractor runs'})`,
    );

    const exactMatcher = new ExactMatcher();
    const semanticMatcher = new SemanticMatcher(embeddingService, threshold); // shared embedding cache across tools

    const scoreOpts = { domainById, ignoreKeys };
    const wanshiScore = await scoreGraph(scoredIds, wanshiGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts);
    const vanillaScore = vanillaGraphs
      ? await scoreGraph(scoredIds, vanillaGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts)
      : null;
    const fullScore = fullGraphs
      ? await scoreGraph(scoredIds, fullGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts)
      : null;
    const kggenScore = haveKggen
      ? await scoreGraph(scoredIds, kggenGraphs, goldById, exactMatcher, semanticMatcher, scoreOpts)
      : null;

    // ── Report ── columns ordered for the decomposition: vanilla → wanshi → wanshi-full → kggen
    const tools: [string, ToolScore][] = [];
    if (vanillaScore) tools.push(['vanilla', vanillaScore]);
    tools.push(['wanshi', wanshiScore]);
    if (fullScore) tools.push(['wanshi-full', fullScore]);
    if (kggenScore) tools.push(['kggen', kggenScore]);

    const lines: string[] = [];
    lines.push('');
    lines.push(`${dataset} two-way  model=${opts.model}  mode=${mode}  N=${scoredIds.length}  thr=${threshold}  prompt=${opts.promptVersion}`);
    lines.push('HEADLINE = node entity-capture (semantic): did the tool recover the gold entities (any node).');
    lines.push('end-* = entity/relation/triple over relation ENDPOINTS; rel/tri understate (abstract gold predicates).');
    if (ignoreKeys) lines.push('ignTri = triple F1 with train-seen triples excluded (Re-DocRED Ign-F1).');
    lines.push('');
    const header =
      `${'tool'.padEnd(12)}${'nodeF1'.padStart(8)}${'nodeP'.padStart(8)}${'nodeR'.padStart(8)}` +
      `${'endEnt'.padStart(8)}${'endRel'.padStart(8)}${'endTri'.padStart(8)}` +
      (ignoreKeys ? `${'ignTri'.padStart(8)}` : '') +
      `${'tri/s'.padStart(7)}${'ent/s'.padStart(7)}`;
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const [name, sc] of tools) {
      lines.push(
        `${name.padEnd(12)}` +
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
    // Headline deltas — the two questions this round answers.
    if (vanillaScore) {
      lines.push('');
      lines.push(
        `Δ prompt   (wanshi − vanilla):     nodeF1 ${signed(wanshiScore.nodeEntitySem.f1 - vanillaScore.nodeEntitySem.f1)}` +
        `   endTri ${signed(wanshiScore.tripletSem.triple.f1 - vanillaScore.tripletSem.triple.f1)}` +
        `   = the v5 prompt's lift over a competent plain prompt (same model + vocab)`,
      );
    }
    if (fullScore) {
      lines.push(
        `Δ pipeline (wanshi-full − wanshi): nodeF1 ${signed(fullScore.nodeEntitySem.f1 - wanshiScore.nodeEntitySem.f1)}` +
        `   endTri ${signed(fullScore.tripletSem.triple.f1 - wanshiScore.tripletSem.triple.f1)}` +
        `   = grounding-drop + merge (AST seed excluded: circular on the code gold)`,
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
    const wShare = relatedToShare(wanshiGraphs, scoredIds);
    lines.push(`wanshi related_to-share: ${f3(wShare.share)} (${wShare.relatedTo}/${wShare.relations} relations)`);
    if (extractionStats) {
      lines.push(
        `wanshi extraction: conformance ${extractionStats.conformanceRate ?? '—'} ` +
        `(${extractionStats.extracted}/${extractionStats.attempted}, ${extractionStats.failedChunks} failed chunks)  ` +
        `${extractionStats.completionTokensPerSec ?? '—'} tok/s [rental≠M4]`);
    }
    lines.push('');
    console.log(lines.join('\n'));

    const graphsByTool: Record<string, Map<string, KnowledgeGraph>> = {
      wanshi: wanshiGraphs, kggen: kggenGraphs,
      ...(vanillaGraphs ? { vanilla: vanillaGraphs } : {}),
      ...(fullGraphs ? { 'wanshi-full': fullGraphs } : {}),
    };
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
      ...(vanillaGraphs ? { vanillaCached: vanillaGraphs.size } : {}),
      ...(fullGraphs ? { fullCached: fullGraphs.size } : {}),
      extraction: extractionStats, // wanshi-side conformance + throughput (H-L3/H-L4 architecture column)
      ...(vanillaStats ? { vanillaExtraction: vanillaStats } : {}),
      tools: Object.fromEntries(tools.map(([name, sc]) => [name, {
        nodeEntityCapture: { semantic: sc.nodeEntitySem, exact: sc.nodeEntityExact },
        tripletEndpoint: { semantic: sc.tripletSem, exact: sc.tripletExact },
        ...(ignoreKeys ? { ignTriplet: { semantic: sc.ignTripletSem, exact: sc.ignTripletExact } } : {}),
        ...(sc.perDomainNode ? { perDomainNodeSemantic: Object.fromEntries(sc.perDomainNode) } : {}),
        triplesPerSample: sc.triplesPer,
        entitiesPerSample: sc.entsPer,
        relatedToShare: relatedToShare(graphsByTool[name], scoredIds), // H5: escape-predicate collapse
      }])),
    };
    fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(`Saved two-way report -> ${output}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
