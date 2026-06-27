#!/usr/bin/env ts-node
/**
 * Fetch FinRED → data/finred/{test,train}.jsonl
 *
 * The canonical FinRED repo (github.com/soummyaah/FinRED) only links Google-Drive data
 * (not scriptable), so we pull the open HF mirror `FinGPT/fingpt-finred-re` via the HF
 * datasets-server. Each HF row is { input: sentence, output: "rel: subj, obj; …",
 * instruction }. We keep { input, output } (the loader parses `output` into triples),
 * dedup identical rows (the mirror doubles each example per instruction variant), and
 * derive data/finred/relations.vocab. Default split = test (the human-annotated eval set).
 *
 *   npx ts-node scripts/fetch-finred.ts                 # test
 *   npx ts-node scripts/fetch-finred.ts --split train   # + train (large, distant-supervised)
 */
import * as fs from 'fs';
import * as path from 'path';

const DATASET = 'FinGPT/fingpt-finred-re';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'finred');
const PAGE = 100;

interface Row { input: string; output: string }
interface RowsResponse { rows: { row: Row }[]; num_rows_total: number }

async function fetchPage(split: string, offset: number): Promise<RowsResponse> {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=default&split=${split}&offset=${offset}&length=${PAGE}`;
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

async function fetchSplit(split: string): Promise<void> {
  const seen = new Set<string>();
  const out: string[] = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const page = await fetchPage(split, offset);
    total = page.num_rows_total;
    if (page.rows.length === 0) break;
    for (const { row } of page.rows) {
      const key = `${row.input}␟${row.output}`;
      if (seen.has(key)) continue; // mirror doubles each example
      seen.add(key);
      out.push(JSON.stringify({ input: row.input, output: row.output }));
    }
    offset += page.rows.length;
    process.stdout.write(`\r  ${split}: ${offset}/${total} fetched, ${out.length} unique`);
  }
  process.stdout.write('\n');
  fs.writeFileSync(path.join(OUT_DIR, `${split}.jsonl`), out.join('\n') + '\n');
  console.log(`  → ${path.join(OUT_DIR, `${split}.jsonl`)} (${out.length} unique rows)`);
}

/** Distinct lowercased predicates across the on-disk splits. */
function deriveVocab(): string[] {
  const preds = new Set<string>();
  for (const split of ['test', 'train']) {
    const p = path.join(OUT_DIR, `${split}.jsonl`);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim(); if (!t) continue;
      let row: Row; try { row = JSON.parse(t); } catch { continue; }
      for (const part of row.output.split(';')) {
        const seg = part.trim();
        const colon = seg.indexOf(':');
        if (colon > 0) preds.add(seg.slice(0, colon).trim().toLowerCase());
      }
    }
  }
  return [...preds].sort();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const argv = process.argv.slice(2);
  const splitArg = argv.includes('--split') ? argv[argv.indexOf('--split') + 1] : undefined;
  const splits = splitArg ? [splitArg] : ['test'];
  console.log(`Fetching ${DATASET} … splits=[${splits.join(', ')}]`);
  for (const split of splits) await fetchSplit(split);

  const vocab = deriveVocab();
  fs.writeFileSync(path.join(OUT_DIR, 'relations.vocab'), vocab.join('\n') + '\n');
  console.log(`\nrelations.vocab (${vocab.length}): ${vocab.join(', ')}`);
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
