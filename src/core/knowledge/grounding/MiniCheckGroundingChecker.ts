import { Ollama } from "ollama";
import { Logger } from "../../../shared";
import { IGroundingChecker, GroundingVerdict } from "../../../types";
import { FactualEvaluator } from "../../../quality/FactualMetrics";
import { splitSentences } from "./verbalize";

export interface MiniCheckOptions {
  /** Ollama model id — default `bespoke-minicheck:7b` (set in the schema). */
  model: string;
  /** Ollama host; defaults to the local daemon. */
  host?: string;
  /** Keyword fallback threshold used when the NLI call errors. */
  min: number;
  /** Keyword score at/above which we accept without an NLI call (pre-filter). */
  escalateAbove: number;
  /**
   * Per-NLI-call timeout (ms). A hung Ollama daemon would otherwise stall the
   * whole (sequential) grounding gate; on timeout the call rejects and the
   * existing catch degrades to the keyword path. Default 30s.
   */
  timeoutMs?: number;
}

/** The slice of the Ollama client this checker needs (injectable for tests). */
export interface MiniCheckClient {
  generate(req: {
    model: string;
    prompt: string;
    stream: false;
    options?: Record<string, unknown>;
    /** Abort the in-flight request (cooperative; the real Ollama client honors it). */
    signal?: AbortSignal;
  }): Promise<{ response: string }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Grounding via MiniCheck (bespoke-minicheck:7b) — a purpose-built
 * `(document, claim) → Yes/No` fact-checker (arXiv:2404.10774). Unlike keyword
 * overlap it rewards paraphrase and doesn't require the verbatim entity name,
 * so snake_case canonical names stop auto-failing (KG-08).
 *
 * Cost control: keyword overlap stays as a cheap pre-filter — a claim with high
 * verbatim overlap (`>= escalateAbove`) is accepted without an NLI call, so only
 * the *uncertain* claims reach MiniCheck. Multi-sentence claims are split to
 * sentences (MiniCheck checks atomic claims); the claim is supported iff every
 * sentence is. A checker failure degrades to the keyword verdict rather than
 * crashing the run.
 */
export class MiniCheckGroundingChecker implements IGroundingChecker {
  private readonly ollama: MiniCheckClient;

  constructor(
    private readonly opts: MiniCheckOptions,
    private readonly logger: Logger,
    client?: MiniCheckClient
  ) {
    this.ollama = client ?? new Ollama({ host: opts.host });
  }

  async check(claim: string, source: string, endpoints?: string[]): Promise<GroundingVerdict> {
    const ks = FactualEvaluator.observationGroundingScore(claim, source);
    // Pre-filter: obvious verbatim grounding skips the NLI call — but for a
    // RELATION (endpoints given), high keyword overlap can come from the predicate
    // word alone (or all-short triple tokens), passing an edge whose endpoints
    // aren't even in the source. Require BOTH endpoints lexically present before
    // the cheap accept; otherwise fall through to the NLI check (or its fallback).
    if (ks >= this.opts.escalateAbove && this.endpointsGrounded(endpoints, source)) {
      return { score: ks, supported: true, checker: "keyword" };
    }

    const sentences = splitSentences(claim);
    if (sentences.length === 0) {
      return { score: 1, supported: true, checker: "minicheck" };
    }

    try {
      let supported = 0;
      for (const sentence of sentences) {
        if (await this.miniCheck(source, sentence)) supported++;
      }
      const score = supported / sentences.length;
      return { score, supported: supported === sentences.length, checker: "minicheck" };
    } catch (error) {
      // Grounding is an enhancement — never let a checker failure crash the run.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `MiniCheck unavailable (${message}); falling back to keyword overlap for this claim`
      );
      return { score: ks, supported: ks >= this.opts.min, checker: "keyword" };
    }
  }

  /**
   * For a relation pre-filter, require BOTH endpoints to be lexically present in
   * the source before accepting on keyword overlap alone. An endpoint is present
   * when any of its content tokens (split on snake_case / non-word chars, >2 chars)
   * appears in the source — paraphrase-tolerant for the predicate, but the
   * endpoints themselves must actually show up. No endpoints ⇒ not a relation,
   * preserve the observation pre-filter unchanged (returns true).
   */
  private endpointsGrounded(endpoints: string[] | undefined, source: string): boolean {
    if (!endpoints || endpoints.length === 0) return true;
    const src = source.toLowerCase();
    const present = (name: string): boolean => {
      const tokens = name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2);
      // A name with only short tokens (e.g. "AI") falls back to a whole-name match.
      if (tokens.length === 0) return src.includes(name.toLowerCase().trim());
      return tokens.some((t) => src.includes(t));
    };
    return endpoints.every(present);
  }

  /** One `(document, claim) → boolean` MiniCheck call, bounded by a timeout so a
   * hung daemon can't stall the gate — on timeout it rejects and the caller's
   * catch degrades to the keyword path. */
  private async miniCheck(document: string, claim: string): Promise<boolean> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`MiniCheck timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.ollama.generate({
          model: this.opts.model,
          prompt: `Document: ${document}\nClaim: ${claim}`,
          stream: false,
          options: { temperature: 0, num_predict: 4 },
          signal: controller.signal,
        }),
        timeout,
      ]);
      return this.parseVerdict(res.response);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Lenient parse: the model emits `Yes`/`No`; tolerate `1`/`true` variants.
   * Match only a leading WHOLE positive token — `yes`/`true` (prefix), or `1`
   * as a standalone token. A digit-prefixed prose answer like `1. No` / `1) Maybe`
   * is a NEGATIVE/ambiguous answer, not a positive `1`, so it must not match.
   */
  private parseVerdict(raw: string): boolean {
    const t = (raw ?? "").trim().toLowerCase();
    if (t.startsWith("yes") || t.startsWith("true")) return true;
    // `1`/`0` only when it's a whole token (end-of-string or a word boundary that
    // is whitespace), so `1. No`, `1)`, `10` don't read as a positive `1`.
    return /^1(?:\s|$)/.test(t);
  }
}
