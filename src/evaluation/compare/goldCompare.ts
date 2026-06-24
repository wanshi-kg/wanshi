// Shared scoring core for the gold-labeled two-way comparisons (wanshi vs KGGen).
//
// Dataset-agnostic: CrossRE (sentence-level, 6 domains), SemEval (sentence-level,
// no domains), Re-DocRED (document-level, Wikidata schema + Ign-F1). The CLI
// (scripts/gold-compare.ts) handles loading/extraction/caching; this module owns
// the metric math so there is ONE source of truth across datasets.
//
// HEADLINE = node entity-capture (semantic): every graph node → a self-triplet →
// matched against gold entities. Fair across open-predicate tools whose free
// predicates won't string/embed-match a dataset's abstract gold predicate vocab.
// Triplet-level entity/relation/triple F1 are also reported (understate uniformly).
//
// Optional per-call extras:
//   - domainById  → per-domain node-capture F1 (CrossRE).
//   - ignoreKeys  → Re-DocRED Ign-F1: drop train-seen (subj|pred|obj) triples from
//                   BOTH gold and predictions before the triplet-level metrics, so a
//                   tool gets no credit for memorized training facts.

import { KnowledgeGraph } from '../../types/KnowledgeGraph';
import { ExactMatcher } from '../matching/ExactMatcher';
import { SemanticMatcher } from '../matching/SemanticMatcher';
import { computeExactMetrics, computeSemanticMetrics, computeMetrics, microAverage } from '../metrics/TripleMetrics';
import { EvalMetrics, LevelMetrics, Triplet } from '../datasets/IDataset';
import { kgToTriplets, nodeTriplets } from '../crossre/compareScoring';

export interface ToolScore {
  /** Entity-capture over the full node set (the fair headline), semantic + exact. */
  nodeEntitySem: EvalMetrics;
  nodeEntityExact: EvalMetrics;
  /** Triplet-derived levels (entity = relation endpoints; relation; triple). */
  tripletSem: LevelMetrics;
  tripletExact: LevelMetrics;
  /** Per-domain node entity-capture (semantic) F1 — present only when domainById given. */
  perDomainNode?: Map<string, EvalMetrics>;
  /** Ign-F1 triplet levels (train-seen triples excluded) — present only when ignoreKeys given. */
  ignTripletSem?: LevelMetrics;
  ignTripletExact?: LevelMetrics;
  triplesPer: number;
  entsPer: number;
}

type Tally = { tp: number; fp: number; fn: number };
const addTally = (a: Tally, b: { tp: number; fp: number; fn: number }) => {
  a.tp += b.tp; a.fp += b.fp; a.fn += b.fn;
};

/** Normalized (subject|predicate|object) key for train-seen-triple exclusion (Ign-F1). */
export function tripleKey(t: Triplet): string {
  return `${t.subject.trim().toLowerCase()}|${t.predicate.trim().toLowerCase()}|${t.object.trim().toLowerCase()}`;
}

export async function scoreGraph(
  ids: string[],
  graphById: Map<string, KnowledgeGraph>,
  goldById: Map<string, Triplet[]>,
  exact: ExactMatcher,
  semantic: SemanticMatcher,
  opts?: { domainById?: Map<string, string>; ignoreKeys?: Set<string> },
): Promise<ToolScore> {
  const domainById = opts?.domainById;
  const ignoreKeys = opts?.ignoreKeys;

  const exactTrip: LevelMetrics[] = [];
  const semTrip: LevelMetrics[] = [];
  const ignExactTrip: LevelMetrics[] = [];
  const ignSemTrip: LevelMetrics[] = [];
  const nodeSem: Tally = { tp: 0, fp: 0, fn: 0 };   // micro-averaged across samples
  const nodeExact: Tally = { tp: 0, fp: 0, fn: 0 };
  const nodeByDomain = new Map<string, Tally>();
  let triples = 0, ents = 0;

  for (const id of ids) {
    const kg = graphById.get(id) ?? { entities: [], relations: [] };
    const gold = goldById.get(id) ?? [];
    const trip = kgToTriplets(kg);
    const nodes = nodeTriplets(kg);
    triples += trip.length;
    ents += kg.entities.length;

    exactTrip.push(computeExactMetrics(trip, gold, exact));
    semTrip.push(await computeSemanticMetrics(trip, gold, semantic));

    // Ign-F1: drop train-seen triples from both sides before scoring.
    if (ignoreKeys) {
      const tripF = trip.filter((t) => !ignoreKeys.has(tripleKey(t)));
      const goldF = gold.filter((t) => !ignoreKeys.has(tripleKey(t)));
      ignExactTrip.push(computeExactMetrics(tripF, goldF, exact));
      ignSemTrip.push(await computeSemanticMetrics(tripF, goldF, semantic));
    }

    // Node entity-capture: match the full node set against gold entities.
    const ns = await semantic.matchEntities(nodes, gold);
    addTally(nodeSem, ns);
    addTally(nodeExact, exact.matchEntities(nodes, gold));

    if (domainById) {
      const d = domainById.get(id) ?? 'unknown';
      if (!nodeByDomain.has(d)) nodeByDomain.set(d, { tp: 0, fp: 0, fn: 0 });
      addTally(nodeByDomain.get(d)!, ns);
    }
  }

  let perDomainNode: Map<string, EvalMetrics> | undefined;
  if (domainById) {
    perDomainNode = new Map();
    for (const [d, t] of nodeByDomain) perDomainNode.set(d, computeMetrics(t.tp, t.fp, t.fn));
  }

  return {
    nodeEntitySem: computeMetrics(nodeSem.tp, nodeSem.fp, nodeSem.fn),
    nodeEntityExact: computeMetrics(nodeExact.tp, nodeExact.fp, nodeExact.fn),
    tripletSem: microAverage(semTrip),
    tripletExact: microAverage(exactTrip),
    perDomainNode,
    ignTripletSem: ignoreKeys ? microAverage(ignSemTrip) : undefined,
    ignTripletExact: ignoreKeys ? microAverage(ignExactTrip) : undefined,
    triplesPer: ids.length ? triples / ids.length : 0,
    entsPer: ids.length ? ents / ids.length : 0,
  };
}

// ─── JSONL cache (append + load + truncation-tolerant; the CheckpointService idiom) ──
export function loadJsonl<T = any>(file: string, fs: typeof import('fs')): Map<string, T> {
  const map = new Map<string, T>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && rec.id !== undefined) map.set(rec.id, rec);
    } catch {
      /* tolerate a truncated final line from an interrupted write */
    }
  }
  return map;
}

export function appendJsonl(file: string, rec: unknown, fs: typeof import('fs')): void {
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8');
}
