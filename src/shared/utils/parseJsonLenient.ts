import { jsonrepair } from "jsonrepair";

/**
 * Parse JSON, repairing malformed output before giving up.
 *
 * Structured-generation responses occasionally arrive broken — most commonly an
 * unterminated string when the model hits its output-token budget mid-emit (the
 * `SyntaxError: Unterminated string in JSON` class seen on large chunks). A plain
 * `JSON.parse` throws and the whole attempt is wasted; `jsonrepair` closes dangling
 * strings/brackets so a truncated-but-mostly-complete object still parses.
 *
 * Fast path first: a well-formed response never touches `jsonrepair`. On repair,
 * `onRepair` is invoked (for a warn log) so the recovery isn't silent.
 */
export function parseJsonLenient(content: string, onRepair?: () => void): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const repaired = jsonrepair(content); // throws if unrepairable — propagate
    onRepair?.();
    return JSON.parse(repaired);
  }
}
