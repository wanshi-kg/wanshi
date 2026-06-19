#!/usr/bin/env ts-node
/**
 * Fetch the MINE benchmark → data/mine/mine.jsonl
 *
 * Pulls rows from the HF datasets-server JSON API (no parquet dep) and writes one
 * projected row per line — only the 7 fields MineDataset reads (essay + facts +
 * the three baseline graphs), dropping the bulky stored judge responses. Rows are
 * fetched one at a time because each carries a large essay + three graphs (larger
 * pages risk per-cell truncation). Idempotent; network-gated; run once.
 *
 *   npx ts-node scripts/fetch-mine.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const DATASET = 'josancamon/kg-gen-MINE-evaluation-dataset';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'mine');
const OUT_PATH = path.join(OUT_DIR, 'mine.jsonl');

// Only the fields MineDataset.parseRow consumes.
const KEEP = [
  'id',
  'essay_topic',
  'essay_content',
  'generated_queries',
  'kggen',
  'graphrag_kg',
  'openie_kg',
] as const;

interface RowsResponse {
  rows: { row: Record<string, unknown>; truncated_cells?: string[] }[];
  num_rows_total: number;
}

async function fetchRow(offset: number): Promise<RowsResponse> {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=default&split=train&offset=${offset}&length=1`;
  for (let attempt = 1; attempt <= 7; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2, 15) * 1000));
      continue;
    }
    if (res.ok) return (await res.json()) as RowsResponse;
    if (res.status === 429 || res.status >= 500) {
      // Back off harder on rate-limit/5xx (the datasets-server throttles bursts).
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2, 15) * 1000));
      continue;
    }
    throw new Error(`HF rows API ${res.status} @${offset}: ${await res.text()}`);
  }
  throw new Error(`HF rows API kept failing @${offset}`);
}

function project(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) out[k] = row[k];
  return out;
}

/** `--limit N` (default all). */
function parseLimit(): number {
  const i = process.argv.indexOf('--limit');
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (n > 0) return n;
  }
  return Infinity;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const limit = parseLimit();

  // Resume: count rows already written so a re-run continues after a flaky abort.
  // (Delete data/mine/mine.jsonl for a clean refetch.)
  let done = 0;
  if (fs.existsSync(OUT_PATH)) {
    done = fs.readFileSync(OUT_PATH, 'utf-8').split('\n').filter((l) => l.trim()).length;
    if (done > 0) console.log(`Resuming from ${done} already-fetched rows`);
  }

  console.log(`Fetching ${DATASET} …`);
  let offset = done;
  let total = Infinity;
  let truncatedCount = 0;

  while (offset < Math.min(total, limit)) {
    const page = await fetchRow(offset);
    total = page.num_rows_total;
    if (page.rows.length === 0) break;
    const entry = page.rows[0];
    if (entry.truncated_cells && entry.truncated_cells.length > 0) {
      truncatedCount++;
      console.warn(`\n  ⚠ row ${offset} truncated cells: ${entry.truncated_cells.join(', ')}`);
    }
    // Append incrementally so progress survives an abort (resume picks it up).
    fs.appendFileSync(OUT_PATH, JSON.stringify(project(entry.row)) + '\n');
    offset += 1;
    process.stdout.write(`\r  ${offset}/${Math.min(total, limit)}`);
    await new Promise((r) => setTimeout(r, 250)); // be polite — avoid the burst 429
  }
  process.stdout.write('\n');

  console.log(`  → ${OUT_PATH} now has ${offset} articles`);
  if (truncatedCount > 0) {
    console.warn(`  ⚠ ${truncatedCount} rows had truncated cells (essay/graph may be incomplete).`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
