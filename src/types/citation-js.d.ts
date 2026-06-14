/**
 * Ambient declarations for Citation.js. The packages ship no `.d.ts` next to
 * their CommonJS `main` (this project compiles with classic
 * `moduleResolution: Node`), so this shim surfaces the minimal surface we use:
 * constructing a `Cite` from BibTeX/CSL input and reading the parsed CSL-JSON
 * array via `.data`. The bibtex plugin is a side-effect import (registers the
 * `@biblatex` input format on require).
 */
declare module "@citation-js/core" {
  /** Parsed CSL-JSON entry (only the fields we read are typed). */
  export interface CslEntry {
    type?: string;
    title?: string;
    DOI?: string;
    author?: Array<{ given?: string; family?: string; literal?: string }>;
    issued?: { "date-parts"?: number[][] };
    [key: string]: unknown;
  }

  export class Cite {
    constructor(data: unknown, options?: unknown);
    data: CslEntry[];
  }
}

declare module "@citation-js/plugin-bibtex";
