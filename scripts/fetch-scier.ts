#!/usr/bin/env ts-node
/**
 * Fetch SciER → data/scier/{train,dev,test,test_ood}.jsonl  (LLM format)
 *
 * Downloads the github.com/edzq/SciER repo tarball, flattens the SciER/LLM/*.jsonl
 * splits into data/scier/, and derives data/scier/relations.vocab (the closed predicate
 * set, lowercased) for the gold-compare H4 mode. Open (GitHub, research use). Idempotent:
 * skips the download when the split files already exist; always rewrites the vocab.
 *
 *   npx ts-node scripts/fetch-scier.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const URL = 'https://github.com/edzq/SciER/archive/refs/heads/main.tar.gz';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'scier');
const SPLITS = ['train', 'dev', 'test', 'test_ood'] as const;

async function download(): Promise<void> {
  console.log(`Downloading ${URL} …`);
  const tgz = path.join(OUT_DIR, 'scier.tar.gz');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`SciER download failed: HTTP ${res.status}`);
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  const tmp = path.join(OUT_DIR, '_extract');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execSync(`tar -xzf "${tgz}" -C "${tmp}"`);
  const top = fs.readdirSync(tmp)[0]; // SciER-main/
  const llmDir = path.join(tmp, top, 'SciER', 'LLM');
  for (const split of SPLITS) {
    const src = path.join(llmDir, `${split}.jsonl`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, `${split}.jsonl`));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tgz, { force: true });
  console.log(`  flattened LLM splits → ${OUT_DIR}`);
}

/** Distinct lowercased predicates across all available splits, sorted. */
function deriveVocab(): string[] {
  const preds = new Set<string>();
  for (const split of SPLITS) {
    const p = path.join(OUT_DIR, `${split}.jsonl`);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { rel?: [string, string, string][] };
        for (const r of row.rel ?? []) if (r[1]) preds.add(r[1].toLowerCase());
      } catch { /* skip */ }
    }
  }
  return [...preds].sort();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const have = SPLITS.some((s) => fs.existsSync(path.join(OUT_DIR, `${s}.jsonl`)));
  if (have) console.log('SciER splits already present — skipping download.');
  else await download();

  const vocab = deriveVocab();
  fs.writeFileSync(path.join(OUT_DIR, 'relations.vocab'), vocab.join('\n') + '\n');
  console.log(`\nrelations.vocab (${vocab.length}): ${vocab.join(', ')}`);
  for (const split of SPLITS) {
    const p = path.join(OUT_DIR, `${split}.jsonl`);
    if (!fs.existsSync(p)) continue;
    const docs = new Set<string>();
    let rows = 0;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const t = line.trim(); if (!t) continue; rows++;
      try { docs.add((JSON.parse(t) as { doc_id: string }).doc_id); } catch { /* skip */ }
    }
    console.log(`  ${split}: ${rows} sentence rows across ${docs.size} documents`);
  }
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
