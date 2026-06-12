import { IContradictionChecker, ContradictionVerdict } from "../../../types";

/**
 * Antonym pairs whose presence on opposite sides of two facts (about the same
 * entity) signals a contradiction. Seeded from FactualMetrics' consistency list
 * and extended with common state/relationship opposites (incl. the Graphiti
 * "joined ↔ left" example).
 */
const ANTONYMS: [string, string][] = [
  ["synchronous", "asynchronous"],
  ["mutable", "immutable"],
  ["public", "private"],
  ["static", "dynamic"],
  ["enabled", "disabled"],
  ["active", "inactive"],
  ["online", "offline"],
  ["open", "closed"],
  ["present", "absent"],
  ["true", "false"],
  ["increased", "decreased"],
  ["joined", "left"],
  ["alive", "dead"],
  ["valid", "invalid"],
  ["supported", "unsupported"],
];

const NEGATION = /\b(not|no|never|none|without|n't|cannot|can't|isn't|aren't|doesn't|didn't|won't)\b/;

const contentWords = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(NEGATION, " ")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

/**
 * Cheap, network-free contradiction detector (KG-10): two facts about one entity
 * contradict when (a) they carry opposite antonyms over a shared topic, or (b)
 * they are near-identical statements but exactly one is negated. Conservative by
 * design — a miss just means a supersession isn't recorded; a false positive would
 * wrongly invalidate a fact, so the bar (shared content) is deliberately high.
 */
export class HeuristicContradictionChecker implements IContradictionChecker {
  async check(a: string, b: string): Promise<ContradictionVerdict> {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    const wa = contentWords(la);
    const wb = contentWords(lb);

    // (a) opposite antonyms over a shared topic
    for (const [x, y] of ANTONYMS) {
      const opposite =
        (hasWord(la, x) && hasWord(lb, y)) || (hasWord(la, y) && hasWord(lb, x));
      if (opposite && shareTopic(wa, wb, x, y)) {
        return { contradicts: true, checker: "heuristic" };
      }
    }

    // (b) same statement, exactly one side negated (asymmetric negation already a
    // strong signal, so a moderate content overlap suffices — tolerant of plurals).
    if (NEGATION.test(la) !== NEGATION.test(lb) && jaccard(wa, wb) >= 0.5) {
      return { contradicts: true, checker: "heuristic" };
    }

    return { contradicts: false, checker: "heuristic" };
  }
}

function hasWord(s: string, w: string): boolean {
  return new RegExp(`\\b${w}\\b`).test(s);
}

/** Require some shared content word other than the antonyms — same topic. */
function shareTopic(wa: Set<string>, wb: Set<string>, x: string, y: string): boolean {
  for (const w of wa) if (w !== x && w !== y && wb.has(w)) return true;
  return false;
}
