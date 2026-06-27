#!/usr/bin/env ts-node
/**
 * Fetch BioRED → data/biored/BioRED/{Train,Dev,Test}.BioC.JSON
 *
 * Downloads the NCBI distribution zip (BioC-JSON + XML + PubTator) and extracts it,
 * then derives data/biored/relations.vocab (the 8 closed relation types, lowercased)
 * for the gold-compare H4 mode (--relation-vocab @data/biored/relations.vocab).
 *
 * Open & freely downloadable (NCBI/NLM, public). Idempotent: skips the download when
 * the split JSONs already exist; always rewrites the vocab.
 *
 *   npx ts-node scripts/fetch-biored.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

const URL = 'https://ftp.ncbi.nlm.nih.gov/pub/lu/BioRED/BIORED.zip';
const OUT_DIR = path.resolve(__dirname, '..', 'data', 'biored');
const ZIP_PATH = path.join(OUT_DIR, 'BIORED.zip');
const SPLIT_DIR = path.join(OUT_DIR, 'BioRED');
const SPLITS = ['Train', 'Dev', 'Test'] as const;

async function download(): Promise<void> {
  console.log(`Downloading ${URL} …`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`BioRED download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ZIP_PATH, buf);
  console.log(`  → ${ZIP_PATH} (${buf.length} bytes)`);
  new AdmZip(ZIP_PATH).extractAllTo(OUT_DIR, /* overwrite */ true);
  console.log(`  extracted → ${SPLIT_DIR}`);
}

/** Distinct lowercased relation types across all splits, sorted. */
function deriveVocab(): string[] {
  const types = new Set<string>();
  for (const split of SPLITS) {
    const p = path.join(SPLIT_DIR, `${split}.BioC.JSON`);
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { documents: { relations?: { infons: { type?: string } }[] }[] };
    for (const doc of data.documents) {
      for (const rel of doc.relations ?? []) {
        if (rel.infons.type) types.add(rel.infons.type.toLowerCase());
      }
    }
  }
  return [...types].sort();
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const haveSplits = SPLITS.every((s) => fs.existsSync(path.join(SPLIT_DIR, `${s}.BioC.JSON`)));
  if (haveSplits) {
    console.log('BioRED splits already present — skipping download.');
  } else {
    await download();
  }

  const vocab = deriveVocab();
  const vocabPath = path.join(OUT_DIR, 'relations.vocab');
  fs.writeFileSync(vocabPath, vocab.join('\n') + '\n');
  console.log(`\nrelations.vocab (${vocab.length}): ${vocab.join(', ')}`);
  console.log(`  → ${vocabPath}`);

  for (const split of SPLITS) {
    const p = path.join(SPLIT_DIR, `${split}.BioC.JSON`);
    if (!fs.existsSync(p)) continue;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { documents: unknown[] };
    console.log(`  ${split}: ${data.documents.length} documents`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
