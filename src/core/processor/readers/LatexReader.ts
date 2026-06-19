import * as fs from "fs";
import { FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { RawCitation, RawReferences } from "./referenceExtraction";

const CITE_CMDS = "cite|citep|citet|citeauthor|citeyear|citealt|citealp|autocite|parencite|textcite|footcite";
const CITE_RE = new RegExp(`\\\\(?:${CITE_CMDS})\\*?\\s*(?:\\[[^\\]]*\\])*\\s*\\{([^}]*)\\}`, "g");

/**
 * Reader for LaTeX source (`.tex`). Two jobs:
 *  - **Clean body** — a best-effort, regex-based de-TeX (a full parser is out of
 *    scope; "match scale to problem"): drop comments + preamble (keeping
 *    title/author), turn `\section` → markdown headings, unwrap text-formatting
 *    commands, drop noise environments (figure/table/tikz/bibliography), strip
 *    residual control sequences and unescape specials → readable prose the LLM
 *    extracts from. Far cleaner than feeding raw `.tex` to the text reader.
 *  - **Citations** — `\cite{}`/`\citep{}`/… keys → `metadata.references.citations`
 *    (gated by `extractCites`, the run's `references.citations` toggle), reusing
 *    the SAME reference pipeline as Markdown/PDF (DirectoryProcessor →
 *    buildReferenceGraph → `cites` edges) — no new edge machinery.
 *
 * `sourceAdapter:"latex"` is stamped centrally from `adapterId()`.
 * Deferred: `\ref`/`\label` intra-doc cross-refs, `\input`/`\include` assembly,
 * sibling `.bib` title resolution, math-heavy fidelity.
 */
export class LatexReader extends FileReader {
  constructor(chunker: TextChunker, logger: Logger, private readonly extractCites: boolean = false) {
    super([".tex"], chunker, logger);
  }

  getName(): string {
    return "LatexReader";
  }

  adapterId(): string {
    return "latex";
  }

  async read(filePath: string): Promise<FileReadResult> {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    try {
      const references: RawReferences = {};
      if (this.extractCites) {
        const citations = this.extractTexCitations(raw);
        if (citations.length) references.citations = citations;
      }
      const body = this.detex(raw);
      const parts = await this.chunker.chunk(body);
      const hasRefs = !!references.citations;
      return {
        chunks: parts.map((p) => ({ ...p })),
        metadata: {
          type: "latex",
          encoding: "utf-8",
          size: body.length,
          ...(hasRefs ? { references } : {}),
        },
      };
    } catch (e) {
      this.logger.warn(`LatexReader could not parse ${filePath}; falling back to plain chunking: ${e}`);
      const parts = await this.chunker.chunk(raw);
      return { chunks: parts.map((p) => ({ ...p })), metadata: { type: "latex-fallback" } };
    }
  }

  private extractTexCitations(raw: string): RawCitation[] {
    const out: RawCitation[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(raw)) !== null) {
      for (const key of m[1].split(",").map((k) => k.trim()).filter(Boolean)) {
        if (seen.has(key)) continue;
        seen.add(key);
        // No id field on RawCitation — the bibkey is the citation's identifier.
        // (A sibling .bib title lookup → richer fields is deferred.)
        out.push({ raw: key });
      }
    }
    return out;
  }

  /** Best-effort LaTeX → plain text. Order matters; each step is a coarse pass. */
  private detex(raw: string): string {
    // 1. strip line comments (a % not escaped as \%)
    let s = raw.replace(/(^|[^\\])%.*$/gm, "$1");

    // 2. lift title/author (they live in the preamble we're about to drop)
    const title = this.firstBraced(s, /\\title\s*\{/);
    const author = this.firstBraced(s, /\\author\s*\{/);

    // 3. keep only the document body when delimited
    const doc = s.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
    const head = [title ? `# ${title}` : "", author || ""].filter(Boolean).join("\n");
    s = (head ? head + "\n\n" : "") + (doc ? doc[1] : s);

    // 4. drop noise environments wholesale
    s = s.replace(
      /\\begin\{(figure\*?|table\*?|tikzpicture|thebibliography|tabular|align\*?|equation\*?|lstlisting|verbatim|minted)\}[\s\S]*?\\end\{\1\}/g,
      ""
    );

    // 5. sectioning → markdown headings; line breaks → newlines
    s = s
      .replace(/\\section\*?\s*\{([^}]*)\}/g, "\n\n# $1\n")
      .replace(/\\subsection\*?\s*\{([^}]*)\}/g, "\n\n## $1\n")
      .replace(/\\subsubsection\*?\s*\{([^}]*)\}/g, "\n\n### $1\n")
      .replace(/\\paragraph\*?\s*\{([^}]*)\}/g, "\n\n**$1** ")
      .replace(/\\\\(\[[^\]]*\])?/g, "\n");

    // 6. drop citation/ref/label commands with their args
    s = s.replace(
      new RegExp(`\\\\(?:${CITE_CMDS}|ref|eqref|pageref|cref|Cref|label)\\*?\\s*(?:\\[[^\\]]*\\])*\\s*\\{[^}]*\\}`, "g"),
      ""
    );
    // 7. drop structural/preamble commands (and any bracket/brace args)
    s = s.replace(
      /\\(?:usepackage|documentclass|input|include|bibliography|bibliographystyle|newcommand|renewcommand|setlength|geometry|hypersetup|maketitle|tableofcontents|footnote)\s*(?:\[[^\]]*\])*\s*(?:\{[^{}]*\})*/g,
      ""
    );

    // 8. unwrap remaining single-arg commands (two passes for light nesting)
    for (let i = 0; i < 2; i++) {
      s = s.replace(/\\[a-zA-Z@]+\*?\s*\{([^{}]*)\}/g, "$1");
    }
    // 9. strip residual control sequences + leftover braces, unescape specials
    s = s
      .replace(/\\[a-zA-Z@]+\*?/g, "")
      .replace(/\\([&%$#_{}])/g, "$1")
      .replace(/[{}]/g, "")
      .replace(/~/g, " ")
      .replace(/``|''/g, '"');

    // 10. tidy whitespace
    return s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /** Inner text of the first `\cmd{ ... }` matched by `re` (brace-balanced). */
  private firstBraced(s: string, re: RegExp): string | undefined {
    const m = s.match(re);
    if (!m || m.index == null) return undefined;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") depth--;
    }
    return s.slice(start, i - 1).trim() || undefined;
  }
}
