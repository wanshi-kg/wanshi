import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// Code corpus — AST relation-extraction gold over a vendored library.
//
// Layout (built by scripts/build-code-gold.ts):
//   <dataPath>/src/**            vendored source files (pinned tag)
//   <dataPath>/gold.jsonl        one { file, symbols, triples } per file, where
//                                `file` is relative to <dataPath>/src and `triples`
//                                are the deterministic calls/depends_on edges.
//
// One BenchmarkSample per source file: text = the file source, groundTruth = its gold
// triples. The model extracts calls/imports from the literal source; the AST seed is NOT
// in the gold-compare path, so scoring pure-LLM output against the outlion-derived gold
// is a fair (non-circular) oracle. Run with --relation-vocab @<dataPath>/relations.vocab.

interface CodeGoldRecord {
  file: string;
  symbols: string[];
  triples: Triplet[];
}

export class CodeDataset implements IDatasetLoader {
  /**
   * @param dataPath  Corpus root (e.g. data/code/flask) holding gold.jsonl + src/.
   * @param limit     Maximum source files to return (0 / MAX_SAFE_INTEGER = all).
   * @param domain    Unused; accepted for interface compatibility.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    const goldPath = path.join(dataPath, 'gold.jsonl');
    if (!fs.existsSync(goldPath)) {
      throw new Error(
        `Code gold not found at: ${goldPath}\n` +
        `Run: npx ts-node scripts/build-code-gold.ts --lib <lib>\n` +
        `(vendors the library source + writes gold.jsonl + relations.vocab)`
      );
    }
    const srcRoot = path.join(dataPath, 'src');
    const records = fs.readFileSync(goldPath, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CodeGoldRecord);

    const samples: BenchmarkSample[] = [];
    for (const rec of records) {
      if (samples.length >= limit) break;
      if (!rec.triples?.length) continue; // a file with no relations can't be scored on triples
      const srcPath = path.join(srcRoot, rec.file);
      if (!fs.existsSync(srcPath)) continue; // source/gold drift — skip rather than throw
      samples.push({
        id: rec.file,
        text: fs.readFileSync(srcPath, 'utf-8'),
        groundTruth: rec.triples,
        domain: 'code',
      });
    }
    return samples;
  }
}
