import * as fs from 'fs';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// SciER LLM-format (Zhang et al., 2024 — github.com/edzq/SciER, SciER/LLM/*.jsonl).
// One JSON object per SENTENCE:
//   { doc_id, sentence, ner: [[surface, type]], rel: [[subj, predicate, obj]], rel_plus: [...] }
// `rel` entries are already surface triples (subject/object strings + a typed predicate
// from a closed set of 9). We group a document's sentence rows by `doc_id` into one
// document-level sample: text = the sentences joined in order, groundTruth = the union of
// the document's `rel` triples (deduplicated). Predicates are lowercased to a single
// canonical form shared with relations.vocab (the H4 closed schema).

interface SciERRow {
  doc_id: string;
  sentence: string;
  rel?: [string, string, string][];
}

export class SciERDataset implements IDatasetLoader {
  /**
   * @param dataPath  Path to a SciER LLM-format split, e.g. data/scier/test.jsonl
   *                  (or test_ood.jsonl / dev.jsonl / train.jsonl).
   * @param limit     Maximum DOCUMENTS to return (0 / MAX_SAFE_INTEGER = all). The cap is
   *                  over documents, not sentence rows.
   * @param domain    Unused; accepted for interface compatibility.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    if (!fs.existsSync(dataPath)) {
      throw new Error(
        `SciER dataset not found at: ${dataPath}\n` +
        `Run: npx ts-node scripts/fetch-scier.ts\n` +
        `(downloads github.com/edzq/SciER → data/scier/{train,dev,test,test_ood}.jsonl)`
      );
    }

    // Group sentence rows into documents, preserving first-seen document order and
    // in-document sentence order. Grouping happens over ALL rows first; the limit is
    // applied to whole documents afterwards (never cutting a document mid-way).
    const order: string[] = [];
    const sentences = new Map<string, string[]>();
    const triplesByDoc = new Map<string, Triplet[]>();
    const seenByDoc = new Map<string, Set<string>>();

    for (const line of fs.readFileSync(dataPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: SciERRow;
      try { row = JSON.parse(trimmed); } catch { continue; }
      const id = row.doc_id;
      if (!sentences.has(id)) { order.push(id); sentences.set(id, []); triplesByDoc.set(id, []); seenByDoc.set(id, new Set()); }
      sentences.get(id)!.push(row.sentence ?? '');
      const seen = seenByDoc.get(id)!;
      const bucket = triplesByDoc.get(id)!;
      for (const tr of row.rel ?? []) {
        const [subject, predicate, object] = tr;
        if (!subject || !predicate || !object) continue;
        const t: Triplet = { subject, predicate: predicate.toLowerCase(), object };
        const key = `${t.subject}␟${t.predicate}␟${t.object}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bucket.push(t);
      }
    }

    const samples: BenchmarkSample[] = [];
    for (const id of order) {
      if (samples.length >= limit) break;
      const groundTruth = triplesByDoc.get(id)!;
      if (groundTruth.length === 0) continue;
      samples.push({ id, text: sentences.get(id)!.join(' '), groundTruth });
    }
    return samples;
  }
}
