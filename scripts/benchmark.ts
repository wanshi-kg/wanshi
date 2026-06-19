#!/usr/bin/env ts-node
/**
 * wanshi benchmark evaluation script
 *
 * Evaluates extraction quality against external RE/KG benchmark datasets.
 * Supported datasets:
 *   - rebel   (CC BY-NC-SA 4.0)  https://huggingface.co/datasets/Babelscape/rebel-dataset
 *   - crossre  (MIT)              https://huggingface.co/datasets/DFKI-SLT/cross_re
 *
 * Usage:
 *   npm run benchmark -- --dataset crossre --data-path ./data/crossre/data.jsonl --limit 20
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

import {
  RebelDataset,
  CrossREDataset,
  RedocredDataset,
  SemEval2010Dataset,
  BenchmarkRunner,
  ConsoleReporter,
  JsonReporter,
  MineDataset,
  MineScorer,
  MineRunner,
  MineReporter,
} from '../src/evaluation';
import { ILLMProvider } from '../src/types/ILLMProvider';

// ─── ProcessingOptions for benchmark ─────────────────────────────────────────
//
// Build a fully-validated *nested* config via parseConfig (the single source of
// truth). The previous flat object was registered as-is by createContainer but
// services read nested paths (options.llm.*), so its sampling/model keys never
// reached the model — the harness was silently running on undefined config.

/** Minimal .env loader (no dotenv dep): populate process.env from a root .env. */
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function buildProcessingOptions(opts: {
  provider: string;
  model: string;
  host: string;
  apiKey?: string;
  classifier: string;
  embeddingsProvider: string;
  embeddingsModel: string;
  embeddingsHost: string;
  promptVersion: string;
}): ProcessingOptions {
  // One sample at a time: chunking / retrieval / corpus profiling / grounding
  // off. Generation targets Ollama or any OpenAI-compatible endpoint
  // (OpenRouter); embeddings default to local Ollama so matching stays free.
  return parseConfig({
    input: 'benchmark',
    filter: ['**/*.txt'],
    output: 'benchmark-kg.json',
    description: 'Benchmark evaluation',
    llm: {
      provider: opts.provider,
      model: opts.model,
      host: opts.host,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      temperature: 0,
      repeatPenalty: 1.1,
      contextLength: 8192,
      seed: 42,
      promptVersion: opts.promptVersion,
    },
    embeddings: {
      provider: opts.embeddingsProvider,
      model: opts.embeddingsModel,
      host: opts.embeddingsHost,
      ...(opts.apiKey && opts.embeddingsProvider === 'openai'
        ? { apiKey: opts.apiKey }
        : {}),
    },
    chunking: { mode: 'disabled' },
    retrieval: { mode: 'disabled' },
    corpus: { profiling: 'disabled' },
    grounding: { mode: 'disabled' },
    classifier: { mode: opts.classifier as any },
    readers: { asr: { mode: 'disabled' }, images: 'disabled', outline: { enabled: false } },
    logging: { level: 'info' },
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command('benchmark');

program
  .description('Evaluate wanshi extraction quality against benchmark datasets')
  .option('--dataset <name>',          'Dataset: rebel | crossre | redocred | semeval | mine',               'rebel')
  .option('--data-path <path>',        'Path to dataset file or directory (CrossRE: dir loads all splits)')
  .option('--limit <n>',               'Max number of samples to evaluate (0 = all)',                        '50')
  .option('--match-threshold <n>',     'Semantic similarity threshold for entity matching (0–1)',            '0.80')
  .option('--request-delay <ms>',      'Delay between samples in ms (pace cloud requests under rate limits)', '0')
  .option('--provider <name>',         'Generation provider: ollama | openai (OpenAI-compatible)',           'ollama')
  .option('--model <name>',            'Model name (Ollama tag, or provider id like google/gemma-3-4b-it)',  'llama3.2:3b')
  .option('--host <url>',              'Ollama host URL, or OpenAI-compatible base URL when provider=openai','http://localhost:11434')
  .option('--api-key <key>',           'API key for OpenAI-compatible provider (else $OPENAI_API_KEY / $WANSHI_API_KEY / .env)')
  .option('--embeddings-provider <n>', 'Embeddings provider: ollama | openai',                               'ollama')
  .option('--embeddings-model <name>', 'Embedding model',                                                    'mxbai-embed-large:335m')
  .option('--embeddings-host <url>',   'Embeddings host / OpenAI-compatible base URL',                       'http://localhost:11434')
  .option('--classifier <mode>',       'Content classifier: disabled | heuristic | llm | bert',              'heuristic')
  .option('--prompt-version <ver>',    'Prompt template version to use (e.g. v4, v4.5)',                    'v4.5')
  .option('--domain <domains>',        'Domain filter: single (ai) or comma-separated (ai,news,science)')
  .option('--output <path>',           'Save full JSON report to this file path')
  // ── MINE-only (--dataset mine): retrieve+judge scoring, four-way comparison ──
  .option('--judge-provider <name>',   'MINE judge provider: ollama | openai (default: generation provider)')
  .option('--judge-model <name>',      'MINE judge model (default: the generation model)')
  .option('--judge-host <url>',        'MINE judge host / OpenAI-compatible base URL (default: generation host)')
  .option('--judge-api-key <key>',     'MINE judge API key (default: the generation key)')
  .option('--retrieval-top-k <n>',     'MINE: entities retrieved per fact (incident triples form the context)','15')
  .option('--no-rescore-baselines',    'MINE: skip re-scoring the stored KGGen/GraphRAG/OpenIE graphs (wanshi only)')
  .action(async (opts) => {
    const datasetName = opts.dataset as string;
    const limitRaw    = parseInt(opts.limit, 10);
    const limit       = limitRaw <= 0 ? Number.MAX_SAFE_INTEGER : limitRaw;
    const threshold   = parseFloat(opts.matchThreshold);
    const requestDelay = parseInt(opts.requestDelay, 10) || 0;
    const dataPath    = opts.dataPath as string | undefined;

    if (!dataPath) {
      console.error('Error: --data-path is required');
      process.exit(1);
    }

    // Bootstrap DI container
    loadDotEnv();
    const processingOptions = buildProcessingOptions({
      provider: opts.provider,
      model: opts.model,
      host: opts.host,
      apiKey: opts.apiKey || process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY,
      classifier: opts.classifier,
      embeddingsProvider: opts.embeddingsProvider,
      embeddingsModel: opts.embeddingsModel,
      embeddingsHost: opts.embeddingsHost,
      promptVersion: opts.promptVersion,
    });

    const container = ContainerFactory.createContainer({ processingOptions });

    const logger           = await container.resolve<Logger>(TYPES.Logger);
    const kgBuilder        = await container.resolve<KnowledgeGraphBuilder>(TYPES.KnowledgeGraphBuilder);
    const promptManager    = (await container.resolve(TYPES.PromptManager)) as PromptManager;
    const embeddingService = await container.resolve<EmbeddingService>(TYPES.EmbeddingService);

    // ── MINE: retrieve+judge, four-way comparison (its own runner/reporter) ──
    if (datasetName === 'mine') {
      // Judge provider — defaults to the generation model; a separate --judge-*
      // model gets its own container (so e.g. a cheap/local judge can score a
      // cloud-extracted graph). The same judge scores all four tools identically.
      let judge = await container.resolve<ILLMProvider>(TYPES.LLMService);
      let judgeModel = opts.model as string;
      if (opts.judgeModel) {
        judgeModel = opts.judgeModel;
        const judgeContainer = ContainerFactory.createContainer({
          processingOptions: buildProcessingOptions({
            provider: opts.judgeProvider || opts.provider,
            model: opts.judgeModel,
            host: opts.judgeHost || opts.host,
            apiKey: opts.judgeApiKey || opts.apiKey || process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY,
            classifier: opts.classifier,
            embeddingsProvider: opts.embeddingsProvider,
            embeddingsModel: opts.embeddingsModel,
            embeddingsHost: opts.embeddingsHost,
            promptVersion: opts.promptVersion,
          }),
        });
        judge = await judgeContainer.resolve<ILLMProvider>(TYPES.LLMService);
      }

      const topK = parseInt(opts.retrievalTopK, 10) || 15;
      const scorer = new MineScorer(embeddingService, judge, { topK });

      logger.info(`Loading MINE from ${dataPath}`);
      const mineSamples = await new MineDataset().load(dataPath, limit);
      logger.info(`Loaded ${mineSamples.length} MINE articles (judge: ${judgeModel}, top-k: ${topK})`);
      if (mineSamples.length === 0) {
        logger.error('No MINE samples loaded — check the data path (run scripts/fetch-mine.ts)');
        process.exit(1);
      }

      const mineRunner = new MineRunner(kgBuilder as any, promptManager, scorer, logger);
      const mineResult = await mineRunner.run(mineSamples, {
        model: opts.model,
        judgeModel,
        rescoreBaselines: opts.rescoreBaselines !== false,
      });

      const mineReporter = new MineReporter();
      mineReporter.print(mineResult);
      if (opts.output) mineReporter.save(mineResult, opts.output);
      return;
    }

    // Load dataset
    logger.info(`Loading dataset: ${datasetName} from ${dataPath}`);
    let loader: RebelDataset | CrossREDataset | RedocredDataset | SemEval2010Dataset;
    if (datasetName === 'rebel') {
      loader = new RebelDataset();
    } else if (datasetName === 'crossre') {
      loader = new CrossREDataset();
    } else if (datasetName === 'redocred') {
      loader = new RedocredDataset();
    } else if (datasetName === 'semeval') {
      loader = new SemEval2010Dataset();
    } else {
      logger.error(`Unknown dataset: ${datasetName}. Supported: rebel, crossre, redocred, semeval`);
      process.exit(1);
    }

    const samples = await loader.load(dataPath, limit, opts.domain);
    logger.info(`Loaded ${samples.length} samples`);

    if (samples.length === 0) {
      logger.error('No samples loaded — check dataset path and format');
      process.exit(1);
    }

    // Run benchmark
    const runner = new BenchmarkRunner(kgBuilder as any, promptManager, embeddingService, logger, threshold, requestDelay);
    const result = await runner.run(samples, {
      datasetName,
      model: opts.model,
      classifier: `${opts.classifier}/${opts.promptVersion}`,
      matchThreshold: threshold,
    });

    // Report
    const consoleReporter = new ConsoleReporter();
    consoleReporter.print(result);

    if (opts.output) {
      const jsonReporter = new JsonReporter();
      jsonReporter.save(result, opts.output);
    }
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
