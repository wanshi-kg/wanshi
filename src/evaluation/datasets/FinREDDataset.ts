import * as fs from 'fs';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// FinRED (Sharma et al., 2022) via the open HF mirror FinGPT/fingpt-finred-re.
// One JSON object per sentence: { input: sentence, output: "rel: subj, obj; rel2: …" }.
// The `output` lists `predicate: subject, object` clauses separated by ';'. FinRED is
// sentence-level, so each row is one sample: text = input, groundTruth = parsed triples
// (predicate lowercased to the shared H4 vocab). The financial entity pairs (person-title,
// person-org, org-org, org-money) are the OSINT-shaped "who-controls-what" relations.

/** Parse "rel: subj, obj; rel2: subj2, obj2" → triples. */
export function parseFinredOutput(output: string): Triplet[] {
  const triples: Triplet[] = [];
  for (const clause of output.split(';')) {
    const seg = clause.trim();
    if (!seg) continue;
    const colon = seg.indexOf(':');
    if (colon <= 0) continue;
    const predicate = seg.slice(0, colon).trim().toLowerCase();
    const comps = seg.slice(colon + 1).split(',').map((c) => c.trim());
    if (comps.length < 2) continue;
    const subject = comps[0];
    const object = comps.slice(1).join(', '); // tolerate a comma inside the object
    if (predicate && subject && object) triples.push({ subject, predicate, object });
  }
  return triples;
}

interface FinREDRow { input: string; output: string }

export class FinREDDataset implements IDatasetLoader {
  /**
   * @param dataPath  Path to a FinRED split, e.g. data/finred/test.jsonl
   * @param limit     Maximum sentences to return (0 / MAX_SAFE_INTEGER = all).
   * @param domain    Unused; accepted for interface compatibility.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    if (!fs.existsSync(dataPath)) {
      throw new Error(
        `FinRED dataset not found at: ${dataPath}\n` +
        `Run: npx ts-node scripts/fetch-finred.ts\n` +
        `(pulls the HF mirror FinGPT/fingpt-finred-re → data/finred/test.jsonl)`
      );
    }

    const samples: BenchmarkSample[] = [];
    const lines = fs.readFileSync(dataPath, 'utf-8').split('\n');
    for (let i = 0; i < lines.length && samples.length < limit; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let row: FinREDRow;
      try { row = JSON.parse(trimmed); } catch { continue; }
      const groundTruth = parseFinredOutput(row.output ?? '');
      if (groundTruth.length === 0) continue;
      samples.push({ id: `finred_${i}`, text: row.input, groundTruth });
    }
    return samples;
  }
}
