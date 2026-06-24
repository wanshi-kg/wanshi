#!/usr/bin/env ts-node
/**
 * Fetch SemEval-2010 Task 8 → data/semeval/{train,test}.jsonl
 *
 * Pulls rows from the HF datasets-server JSON API (no parquet dep) and writes one
 * { sentence, relation } object per line — the shape SemEval2010Dataset reads.
 * Idempotent: overwrites the output files. Network-gated, run once.
 *
 *   npx ts-node scripts/fetch-semeval.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SEMEVAL_LABELS } from '../src/evaluation/datasets/SemEval2010Dataset';

const DATASET = 'SemEvalWorkshop/sem_eval_2010_task_8';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'semeval');
const PAGE = 100; // SemEval cells are tiny → max page size is safe (no cell truncation)

interface RowsResponse {
  rows: { row: { sentence: string; relation: number | string } }[];
  num_rows_total: number;
}

async function fetchPage(split: string, offset: number): Promise<RowsResponse> {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=default&split=${split}&offset=${offset}&length=${PAGE}`;
  // The HF datasets-server rate-limits a long page sweep, so back off generously
  // (exponential, capped) and tolerate transient network errors, not just HTTP codes.
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as RowsResponse;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** (attempt - 1))));
        continue;
      }
      throw new Error(`HF rows API ${res.status} for ${split}@${offset}: ${await res.text()}`);
    } catch (err) {
      if (attempt === 8) throw err;
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** (attempt - 1))));
    }
  }
  throw new Error(`HF rows API kept failing for ${split}@${offset}`);
}

async function fetchSplit(split: string, max: number): Promise<void> {
  const outPath = path.join(OUT_DIR, `${split}.jsonl`);
  // Resume: count rows already on disk and skip past them (append-only), so a
  // rate-limit interruption mid-sweep doesn't throw away progress — re-run continues.
  let offset = 0;
  if (fs.existsSync(outPath)) {
    offset = fs.readFileSync(outPath, 'utf-8').split('\n').filter((l) => l.trim()).length;
    if (offset) console.log(`  ${split}: resuming from ${offset} rows already on disk`);
  }
  let total = Infinity;

  while (offset < total && offset < max) {
    const page = await fetchPage(split, offset);
    total = page.num_rows_total;
    if (page.rows.length === 0) break;
    const batch: string[] = [];
    for (const { row } of page.rows) {
      // Resolve the ClassLabel integer to its canonical string for a readable,
      // self-contained JSONL (the loader also tolerates the raw integer).
      const relation =
        typeof row.relation === 'number' ? SEMEVAL_LABELS[row.relation] ?? row.relation : row.relation;
      batch.push(JSON.stringify({ sentence: row.sentence, relation }));
    }
    fs.appendFileSync(outPath, batch.join('\n') + '\n');  // incremental → resumable
    offset += page.rows.length;
    process.stdout.write(`\r  ${split}: ${offset}/${Math.min(total, max)}`);
  }
  process.stdout.write('\n');
  console.log(`  → ${outPath} now holds ${Math.min(offset, max)} rows`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Args: `--split test` (default both), `--limit N` (per-split cap; 0 = all).
  const argv = process.argv.slice(2);
  const splitArg = argv.includes('--split') ? argv[argv.indexOf('--split') + 1] : undefined;
  const limitArg = argv.includes('--limit') ? parseInt(argv[argv.indexOf('--limit') + 1], 10) : 0;
  const splits = splitArg ? [splitArg] : ['train', 'test'];
  const max = limitArg > 0 ? limitArg : Infinity;
  console.log(`Fetching ${DATASET} … splits=[${splits.join(', ')}]${limitArg ? ` limit=${limitArg}` : ''}`);
  for (const split of splits) {
    await fetchSplit(split, max);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
