import { TermCount } from "../../types";

/**
 * Compact English stopword set. Not exhaustive — just enough to keep the top-N
 * terms dominated by content words rather than glue. Kept inline (no dependency)
 * to match the project's brutalist tendency.
 */
export const DEFAULT_STOPWORDS = new Set<string>([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
  "her", "was", "one", "our", "out", "his", "has", "him", "how", "its", "may",
  "new", "now", "old", "see", "two", "way", "who", "did", "get", "let", "put",
  "say", "she", "too", "use", "that", "this", "with", "have", "from", "they",
  "will", "would", "there", "their", "what", "about", "which", "when", "make",
  "like", "time", "just", "know", "into", "your", "some", "could", "them",
  "than", "then", "look", "only", "come", "over", "also", "back", "after",
  "work", "first", "well", "even", "want", "because", "these", "give", "most",
  "been", "were", "such", "very", "more", "much", "many", "here", "does", "each",
  "where", "while", "those", "being", "every", "should", "shall", "might",
  "must", "ever", "thing", "things", "really", "actually", "going", "kind",
  "okay", "yeah", "right", "lot", "got", "etc",
]);

export interface CountTermsOptions {
  topN?: number;
  minLength?: number;
  stopwords?: Set<string>;
}

/** Capitalized multiword runs (2–4 words) → likely proper-noun entity names. */
const PROPER_NOUN_RE = /\b[A-Z][A-Za-z0-9'’]+(?:\s+[A-Z][A-Za-z0-9'’]+){1,3}\b/g;
/** Word-ish single tokens (letters/digits, internal '-_'). */
const WORD_RE = /[a-z0-9](?:[a-z0-9'’_-]*[a-z0-9])?/g;

/**
 * Sentence-openers / determiners that get capitalized at the start of a sentence
 * and wrongly absorbed into a proper-noun run (e.g. "The Naive Bayes Classifier").
 * Deliberately narrow — excludes content words that are also stopwords but can
 * legitimately start a name (e.g. "New" in "New York").
 */
const LEADING_TRIM = new Set([
  "the", "a", "an", "this", "that", "these", "those", "we", "you", "they",
  "it", "he", "she", "but", "and", "or", "so", "then", "if", "when", "while",
  "as", "in", "on", "at", "for", "to", "of",
]);

/** Drop leading determiner/opener words; keep the run only if ≥ 2 words remain. */
function normalizeProperNoun(run: string): string | undefined {
  const words = run.trim().split(/\s+/);
  while (words.length > 0 && LEADING_TRIM.has(words[0].toLowerCase())) {
    words.shift();
  }
  return words.length >= 2 ? words.join(" ") : undefined;
}

/**
 * Count term frequency across a set of texts and return the top-N ranked terms.
 *
 * Two signals are merged: lowercased single content words (stopwords / pure
 * numbers / sub-`minLength` dropped) and original-cased capitalized multiword
 * runs (proper-noun candidates). Deterministic: ties break alphabetically.
 */
export function countTerms(
  texts: string[],
  options: CountTermsOptions = {}
): TermCount[] {
  const topN = options.topN ?? 100;
  const minLength = options.minLength ?? 3;
  const stop = options.stopwords ?? DEFAULT_STOPWORDS;

  const counts = new Map<string, number>();
  const bump = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);

  for (const text of texts) {
    if (!text) continue;

    // Proper-noun candidates keep their original casing (canonical names).
    for (const m of text.match(PROPER_NOUN_RE) ?? []) {
      const proper = normalizeProperNoun(m);
      if (proper) bump(proper);
    }

    // Single content words, lowercased.
    for (const w of text.toLowerCase().match(WORD_RE) ?? []) {
      if (w.length < minLength) continue;
      if (/^\d+$/.test(w)) continue; // pure numbers carry no naming signal
      if (stop.has(w)) continue;
      bump(w);
    }
  }

  return Array.from(counts.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, topN);
}
