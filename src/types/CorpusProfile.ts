import { ClassificationResult } from "./ContentClass";

/** A single frequency-ranked term from the corpus pre-pass. */
export interface TermCount {
  term: string;
  count: number;
}

/**
 * Corpus-specific controlled vocabulary suggested by the pre-pass LLM call.
 * `entityNames` are canonical *names* (soft hints — never an enum); `entityTypes`
 * may union into the extraction entityType enum; `relationTypes` steer relations.
 */
export interface CorpusGlossary {
  entityNames: string[];
  entityTypes: string[];
  relationTypes: string[];
}

/**
 * Result of the optional corpus analysis pre-pass, cached to a sidecar
 * (`<output>.corpus-profile.json`). Built once before extraction and threaded
 * into prompts so per-chunk extraction converges on consistent entity naming.
 */
export interface CorpusProfile {
  generatedAt: string;
  /** Validity key (sorted relpaths + model + topN + classifier). Stale ⇒ rebuild. */
  key: string;
  fileCount: number;
  /** Aggregated corpus-level content-class guess. */
  corpusClasses: ClassificationResult[];
  /** Per-file classification keyed by path-relative-to-input (cache for reuse). */
  perFileClasses: Record<string, ClassificationResult[]>;
  topTerms: TermCount[];
  glossary: CorpusGlossary;
  // clusters?: { label: string; terms: string[] }[]; // v2 seam — embedding clustering (deferred)
}

/**
 * Corpus profiling mode:
 * - "disabled": no pre-pass (default)
 * - "enabled": run/load the corpus profile and inject its glossary
 */
export type CorpusProfilingMode = "disabled" | "enabled";
