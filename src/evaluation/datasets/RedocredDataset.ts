import * as fs from 'fs';
import { BenchmarkSample, IDatasetLoader, Triplet } from './IDataset';

// RE-DocRED JSON format (Qin et al., 2022):
// Array of documents, each with:
// {
//   title: "...",
//   sents: [["The", "Loud", "Tour", ...], [...], ...],   // sentences as token arrays
//   vertexSet: [                                           // entity groups
//     [{ name, pos, sent_id, type, global_pos, index }, ...],  // multiple mentions
//     ...
//   ],
//   labels: [{ r: "P577", h: 0, t: 6, evidence: [1] }, ...]   // relations (Wikidata PIDs)
// }
//
// Entity name resolution: longest mention in the group (most specific surface form).
// Text reconstruction: token-join all sentences with a single space between sentences.
// Relation labels: Wikidata property IDs are mapped to human-readable names via
//   WIKIDATA_PROP_LABELS so the semantic matcher can compare them meaningfully.

// ─── Wikidata property ID → readable label ────────────────────────────────────
// Covers all 96 RE-DocRED relation types.
const WIKIDATA_PROP_LABELS: Record<string, string> = {
  P6:    'head of government',
  P17:   'country',
  P19:   'place of birth',
  P20:   'place of death',
  P22:   'father',
  P25:   'mother',
  P26:   'spouse',
  P27:   'country of citizenship',
  P30:   'continent',
  P31:   'instance of',
  P35:   'head of state',
  P36:   'capital',
  P37:   'official language',
  P39:   'position held',
  P40:   'child',
  P50:   'author',
  P54:   'member of sports team',
  P57:   'director',
  P58:   'screenwriter',
  P69:   'educated at',
  P86:   'composer',
  P102:  'member of political party',
  P108:  'employer',
  P112:  'founded by',
  P118:  'league',
  P123:  'publisher',
  P127:  'owned by',
  P131:  'located in administrative entity',
  P136:  'genre',
  P137:  'operator',
  P140:  'religion or worldview',
  P150:  'contains administrative entity',
  P155:  'follows',
  P156:  'followed by',
  P159:  'headquarters location',
  P161:  'cast member',
  P162:  'producer',
  P166:  'award received',
  P170:  'creator',
  P171:  'parent taxon',
  P172:  'ethnic group',
  P175:  'performer',
  P176:  'manufacturer',
  P178:  'developer',
  P179:  'series',
  P190:  'twinned administrative body',
  P194:  'legislative body',
  P205:  'basin country',
  P206:  'located next to body of water',
  P241:  'military branch',
  P264:  'record label',
  P272:  'production company',
  P276:  'location',
  P279:  'subclass of',
  P355:  'subsidiary',
  P361:  'part of',
  P364:  'original language',
  P400:  'platform',
  P403:  'mouth of watercourse',
  P449:  'original network',
  P463:  'member of',
  P488:  'chairperson',
  P495:  'country of origin',
  P527:  'has part',
  P551:  'residence',
  P569:  'date of birth',
  P570:  'date of death',
  P571:  'inception date',
  P576:  'dissolved date',
  P577:  'publication date',
  P580:  'start time',
  P582:  'end time',
  P585:  'point in time',
  P607:  'conflict',
  P674:  'characters',
  P676:  'lyrics by',
  P706:  'located on terrain feature',
  P710:  'participant',
  P737:  'influenced by',
  P740:  'location of formation',
  P749:  'parent organization',
  P800:  'notable work',
  P807:  'separated from',
  P840:  'narrative location',
  P937:  'work location',
  P1001: 'applies to jurisdiction',
  P1056: 'product or material produced',
  P1198: 'unemployment rate',
  P1336: 'territory claimed by',
  P1344: 'participant in',
  P1365: 'replaces',
  P1366: 'replaced by',
  P1376: 'capital of',
  P1412: 'languages spoken or written',
  P1441: 'present in work',
  P3373: 'sibling',
};

// ─── Raw format types ─────────────────────────────────────────────────────────

interface RedocredMention {
  name:       string;
  pos:        [number, number]; // token span within sent_id
  sent_id:    number;
  type:       string;           // LOC | ORG | PER | MISC | NUM | TIME
  global_pos: [number, number];
  index:      string;
}

interface RedocredLabel {
  r:        string;   // Wikidata property ID, e.g. "P577"
  h:        number;   // head entity index into vertexSet
  t:        number;   // tail entity index into vertexSet
  evidence: number[]; // supporting sentence IDs
}

interface RedocredDoc {
  title:     string;
  sents:     string[][];         // sents[i] = array of tokens in sentence i
  vertexSet: RedocredMention[][]; // vertexSet[i] = all mentions of entity i
  labels:    RedocredLabel[];
}

// ─── Dataset loader ───────────────────────────────────────────────────────────

export class RedocredDataset implements IDatasetLoader {
  /**
   * Load RE-DocRED samples.
   *
   * @param dataPath  Path to one of the JSON files:
   *                    data/redocred/test_revised.json   ← use for benchmarking
   *                    data/redocred/dev_revised.json
   *                    data/redocred/train_revised.json
   * @param limit     Maximum samples to return (0 / MAX_SAFE_INTEGER = all).
   * @param domain    Unused — RE-DocRED has no domain splits. Accepted for
   *                  interface compatibility; pass undefined.
   */
  async load(dataPath: string, limit: number, _domain?: string): Promise<BenchmarkSample[]> {
    if (!fs.existsSync(dataPath)) {
      throw new Error(
        `RE-DocRED dataset not found at: ${dataPath}\n` +
        `Download from: https://github.com/tonytan48/Re-DocRED\n` +
        `Expected files: test_revised.json, dev_revised.json, train_revised.json`
      );
    }

    const raw: RedocredDoc[] = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const samples: BenchmarkSample[] = [];

    for (let i = 0; i < raw.length && samples.length < limit; i++) {
      const doc = raw[i];

      if (!doc.sents?.length || !doc.vertexSet?.length || !doc.labels?.length) continue;

      // Reconstruct full text by joining tokens across all sentences
      const text = doc.sents.map(sent => sent.join(' ')).join(' ');

      // Build entity index: entity group idx → canonical name (longest mention)
      const entityNames = doc.vertexSet.map(mentions =>
        mentions.reduce((best, m) => m.name.length > best.length ? m.name : best, '')
      );

      // Build ground-truth triplets
      const groundTruth: Triplet[] = [];
      for (const label of doc.labels) {
        const subject   = entityNames[label.h];
        const object    = entityNames[label.t];
        const predicate = WIKIDATA_PROP_LABELS[label.r] ?? label.r;

        if (subject && object && predicate) {
          groundTruth.push({ subject, predicate, object });
        }
      }

      if (groundTruth.length === 0) continue;

      samples.push({
        id:          `${doc.title.replace(/\s+/g, '_')}_${i}`,
        text,
        groundTruth,
        // No domain field in RE-DocRED; omit rather than set to undefined
      });
    }

    return samples;
  }
}
