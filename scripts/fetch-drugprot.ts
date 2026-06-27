#!/usr/bin/env ts-node
/**
 * Fetch DrugProt → data/drugprot/drugprot-gs-training-development/{training,development}/
 *
 * Downloads the Zenodo gold-standard zip (CC-BY-4.0) and extracts the parallel TSVs,
 * then derives data/drugprot/relations.vocab (the 13 chemical↔gene relation classes,
 * lowercased) for the gold-compare H4 mode. Idempotent: skips the download when the
 * split dirs exist; always rewrites the vocab. The `development` split is the eval set
 * (the shared-task test set is not distributed).
 *
 *   npx ts-node scripts/fetch-drugprot.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const URL = 'https://zenodo.org/records/5042151/files/drugprot-gs-training-development.zip?download=1';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'drugprot');
const ROOT = path.join(OUT_DIR, 'drugprot-gs-training-development');
const SPLITS = ['training', 'development'] as const;

async function download(): Promise<void> {
  console.log(`Downloading DrugProt (Zenodo 5042151) …`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`DrugProt download failed: HTTP ${res.status}`);
  const zipPath = path.join(OUT_DIR, 'drugprot.zip');
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  new AdmZip(zipPath).extractAllTo(OUT_DIR, /* overwrite */ true);
  fs.rmSync(zipPath, { force: true });
  console.log(`  extracted → ${ROOT}`);
}

/** Distinct lowercased relation types across both splits, sorted. */
function deriveVocab(): string[] {
  const preds = new Set<string>();
  for (const split of SPLITS) {
    const dir = path.join(ROOT, split);
    if (!fs.existsSync(dir)) continue;
    const rel = fs.readdirSync(dir).find((f) => f.endsWith('_relations.tsv'));
    if (!rel) continue;
    for (const line of fs.readFileSync(path.join(dir, rel), 'utf-8').split('\n')) {
      const cols = line.split('\t');
      if (cols.length >= 2 && cols[1]) preds.add(cols[1].toLowerCase());
    }
  }
  return [...preds].sort();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const have = SPLITS.every((s) => fs.existsSync(path.join(ROOT, s)));
  if (have) console.log('DrugProt splits already present — skipping download.');
  else await download();

  const vocab = deriveVocab();
  fs.writeFileSync(path.join(OUT_DIR, 'relations.vocab'), vocab.join('\n') + '\n');
  console.log(`\nrelations.vocab (${vocab.length}): ${vocab.join(', ')}`);
  for (const split of SPLITS) {
    const dir = path.join(ROOT, split);
    if (!fs.existsSync(dir)) continue;
    const abs = fs.readdirSync(dir).find((f) => f.endsWith('_abstracs.tsv'));
    const rel = fs.readdirSync(dir).find((f) => f.endsWith('_relations.tsv'));
    const nAbs = abs ? fs.readFileSync(path.join(dir, abs), 'utf-8').split('\n').filter(Boolean).length : 0;
    const nRel = rel ? fs.readFileSync(path.join(dir, rel), 'utf-8').split('\n').filter(Boolean).length : 0;
    console.log(`  ${split}: ${nAbs} abstracts, ${nRel} relations`);
  }
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
