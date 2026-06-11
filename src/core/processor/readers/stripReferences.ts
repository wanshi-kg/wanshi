/**
 * Trailing references/bibliography quarantine (academic-paper hygiene).
 *
 * Bibliography text extracted as content turns citation titles into observations
 * and author surnames into garbage person-entities tangled into nonsense relations
 * (`B. Thirion has_attribute red pepper`). These helpers split the references
 * section off BEFORE chunking/extraction; the tail is dropped, not extracted.
 *
 * Heuristic: the LAST line that is a references-style heading, located in the
 * final 40% of the document — early "References" mentions (e.g. a section that
 * discusses related work) are never treated as the bibliography.
 */

const REF_HEADING =
  /^(?:#{1,6}\s*)?(?:[\divxlc]+\.?\s+)?(references|bibliography|works cited)\s*:?\s*$/i;

export interface SplitReferencesResult {
  body: string;
  references?: string;
}

/** Split plain/markdown text at the trailing references heading. */
export function splitTrailingReferences(text: string): SplitReferencesResult {
  const lines = text.split("\n");
  const earliest = Math.floor(lines.length * 0.6);
  for (let i = lines.length - 1; i >= earliest; i--) {
    if (REF_HEADING.test(lines[i].trim())) {
      return {
        body: lines.slice(0, i).join("\n"),
        references: lines.slice(i).join("\n"),
      };
    }
  }
  return { body: text };
}

export interface SplitPagesResult {
  pages: string[];
  references?: string;
}

/**
 * Page-array variant (PDF readers): truncate the page containing the trailing
 * references heading and drop all subsequent pages.
 */
export function splitPagesAtReferences(pages: string[]): SplitPagesResult {
  const totalChars = pages.reduce((acc, p) => acc + p.length, 0);
  const earliestChar = totalChars * 0.6;

  let offset = totalChars;
  for (let p = pages.length - 1; p >= 0; p--) {
    offset -= pages[p].length;
    const lines = pages[p].split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!REF_HEADING.test(lines[i].trim())) continue;
      const headingChar = offset + lines.slice(0, i).join("\n").length;
      if (headingChar < earliestChar) continue;
      const body = lines.slice(0, i).join("\n");
      const tail = [lines.slice(i).join("\n"), ...pages.slice(p + 1)].join("\n");
      const kept = [...pages.slice(0, p)];
      if (body.trim().length > 0) kept.push(body);
      return { pages: kept, references: tail };
    }
  }
  return { pages };
}
