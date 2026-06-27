import * as fs from 'fs';
import * as path from 'path';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// DrugProt (BioCreative VII, Zenodo 5042151) — chemical↔gene relations, 13 classes.
// A split directory holds three parallel TSVs (note the upstream "abstracs" typo):
//   *_abstracs.tsv   pmid \t title \t abstract
//   *_entities.tsv   pmid \t term_id(T#) \t type \t start \t end \t text
//   *_relations.tsv  pmid \t relation_type \t Arg1:T# \t Arg2:T#
// A relation is grounded by joining its Arg term_ids to the entity surface text within
// the same pmid (verified: 0% unresolved). One document-level sample per pmid: text =
// title + abstract, groundTruth = its resolved binary triples (predicate lowercased to
// the shared H4 vocab). The hidden shared-task test set is not distributed, so the
// `development` split is the eval set.

function readTsv(filePath: string): string[][] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t'));
}

/** Locate the three split TSVs inside a directory by their suffixes. */
function resolveSplitFiles(dir: string): { abstracts: string; entities: string; relations: string } {
  const files = fs.readdirSync(dir);
  const find = (suffix: string): string => {
    const f = files.find((x) => x.endsWith(suffix));
    if (!f) throw new Error(`DrugProt: no *${suffix} in ${dir}`);
    return path.join(dir, f);
  };
  return { abstracts: find('_abstracs.tsv'), entities: find('_entities.tsv'), relations: find('_relations.tsv') };
}

export class DrugProtDataset implements IDatasetLoader {
  /**
   * @param dataPath  A split directory, e.g.
   *                  data/drugprot/drugprot-gs-training-development/development
   * @param limit     Maximum DOCUMENTS (pmids with ≥1 relation) to return.
   * @param domain    Unused; accepted for interface compatibility.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    if (!fs.existsSync(dataPath) || !fs.statSync(dataPath).isDirectory()) {
      throw new Error(
        `DrugProt split directory not found: ${dataPath}\n` +
        `Run: npx ts-node scripts/fetch-drugprot.ts\n` +
        `(downloads Zenodo 5042151 → data/drugprot/.../{training,development})`
      );
    }
    const { abstracts, entities, relations } = resolveSplitFiles(dataPath);

    // pmid → (term_id → surface)
    const entById = new Map<string, Map<string, string>>();
    for (const [pmid, tid, , , , text] of readTsv(entities)) {
      if (!entById.has(pmid)) entById.set(pmid, new Map());
      entById.get(pmid)!.set(tid, text);
    }

    // pmid → resolved triples (deduplicated)
    const triplesByPmid = new Map<string, Triplet[]>();
    const seenByPmid = new Map<string, Set<string>>();
    for (const [pmid, rtype, arg1, arg2] of readTsv(relations)) {
      const ents = entById.get(pmid);
      // The real development split has a few malformed/short relation rows (missing an Arg
      // id) the fixture didn't — skip them instead of crashing on arg1.split (was a TypeError).
      if (!ents || !arg1 || !arg2) continue;
      const subject = ents.get(arg1.split(':')[1]);
      const object = ents.get(arg2.split(':')[1]);
      if (!subject || !object || !rtype) continue;
      if (!triplesByPmid.has(pmid)) { triplesByPmid.set(pmid, []); seenByPmid.set(pmid, new Set()); }
      const t: Triplet = { subject, predicate: rtype.toLowerCase(), object };
      const key = `${t.subject}␟${t.predicate}␟${t.object}`;
      if (seenByPmid.get(pmid)!.has(key)) continue;
      seenByPmid.get(pmid)!.add(key);
      triplesByPmid.get(pmid)!.push(t);
    }

    const samples: BenchmarkSample[] = [];
    for (const [pmid, title, abstract] of readTsv(abstracts)) {
      if (samples.length >= limit) break;
      const groundTruth = triplesByPmid.get(pmid);
      if (!groundTruth?.length) continue;
      samples.push({ id: pmid, text: `${title} ${abstract}`, groundTruth });
    }
    return samples;
  }
}
