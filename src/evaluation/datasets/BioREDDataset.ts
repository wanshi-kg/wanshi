import * as fs from 'fs';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// BioRED BioC-JSON format (Luo et al., 2022 — biored.zip, NCBI FTP).
// {
//   source, date, key,
//   documents: [
//     {
//       id: "15485686",                       // PMID
//       passages: [                            // title + abstract
//         { offset, text, annotations: [
//             { id, infons: { identifier, type }, text, locations: [{offset,length}] }
//         ]}
//       ],
//       relations: [                           // DOCUMENT-LEVEL, all binary
//         { id, infons: { entity1, entity2, type, novel } }
//       ]
//     }
//   ]
// }
//
// Relations key entity *concept identifiers* (entity1/entity2), not annotation ids,
// so a relation is grounded by resolving each identifier to a surface mention. An
// annotation may carry MULTIPLE identifiers joined by `,`/`;` (a mention normalized
// to several concepts) — splitting them is what makes id→surface resolution complete
// (verified: 8.3% Train / 14.9% Test unresolved → 0% once split). Entity name =
// longest mention for that identifier (most specific surface form, as RE-DocRED does).
// All relations are binary here, so there is no n-ary case to drop.

const BIORED_SPLIT_RE = /[,;]/;

interface BioREDAnnotation {
  infons: { identifier?: string; type?: string };
  text: string;
}
interface BioREDPassage {
  text: string;
  annotations?: BioREDAnnotation[];
}
interface BioREDRelation {
  infons: { entity1?: string; entity2?: string; type?: string; novel?: string };
}
interface BioREDDoc {
  id: string;
  passages: BioREDPassage[];
  relations?: BioREDRelation[];
}
interface BioREDFile {
  documents: BioREDDoc[];
}

/** Concept identifier → longest surface mention, splitting multi-id annotations. */
function buildIdMap(doc: BioREDDoc): Map<string, string> {
  const idMap = new Map<string, string>();
  for (const passage of doc.passages) {
    for (const ann of passage.annotations ?? []) {
      const identifier = ann.infons.identifier;
      if (!identifier) continue;
      for (const raw of identifier.split(BIORED_SPLIT_RE)) {
        const sub = raw.trim();
        if (!sub || sub === '-') continue;
        const cur = idMap.get(sub) ?? '';
        if (ann.text.length > cur.length) idMap.set(sub, ann.text);
      }
    }
  }
  return idMap;
}

export class BioREDDataset implements IDatasetLoader {
  /**
   * Load BioRED samples.
   *
   * @param dataPath  Path to a BioC-JSON split file:
   *                    data/biored/BioRED/Test.BioC.JSON   ← use for benchmarking
   *                    data/biored/BioRED/Dev.BioC.JSON
   *                    data/biored/BioRED/Train.BioC.JSON
   * @param limit     Maximum samples to return (0 / MAX_SAFE_INTEGER = all).
   * @param domain    Unused — BioRED has no domain splits. Accepted for interface
   *                  compatibility; pass undefined.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    if (!fs.existsSync(dataPath)) {
      throw new Error(
        `BioRED dataset not found at: ${dataPath}\n` +
        `Run: npx ts-node scripts/fetch-biored.ts\n` +
        `(downloads NCBI BIORED.zip → data/biored/BioRED/{Train,Dev,Test}.BioC.JSON)`
      );
    }

    const raw: BioREDFile = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const samples: BenchmarkSample[] = [];

    for (let i = 0; i < raw.documents.length && samples.length < limit; i++) {
      const doc = raw.documents[i];
      if (!doc.passages?.length || !doc.relations?.length) continue;

      const idMap = buildIdMap(doc);
      const text = doc.passages.map((p) => p.text).join(' ');

      const groundTruth: Triplet[] = [];
      for (const rel of doc.relations) {
        const subject = rel.infons.entity1 ? idMap.get(rel.infons.entity1) : undefined;
        const object = rel.infons.entity2 ? idMap.get(rel.infons.entity2) : undefined;
        const predicate = rel.infons.type?.toLowerCase();
        if (subject && object && predicate) {
          groundTruth.push({ subject, predicate, object });
        }
      }

      if (groundTruth.length === 0) continue;

      samples.push({ id: doc.id, text, groundTruth });
    }

    return samples;
  }
}
