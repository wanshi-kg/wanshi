import { IContentClassifier } from "./IContentTypeClassifier";
import { ClassificationResult, ContentClass } from "../../../types";
import { activeDomainClasses } from "../../knowledge/vocabulary";
import { Logger } from "../../../shared";
import { trace } from "../../trace";

/**
 * Per-run cap on LLM tie-break escalations — a cost guard so an ambiguous corpus
 * can't fan out into unbounded LLM calls. (A1 will lift this to config.)
 */
export const DEFAULT_MAX_ESCALATIONS = 50;

/**
 * Phase-B confidence cascade: the cheap heuristic decides the easy majority; only
 * a genuine *tie* is escalated to the LLM, which disambiguates among the two
 * candidates the heuristic couldn't separate.
 *
 * The escalation trigger reuses the exact Phase-A gate: `activeDomainClasses`
 * returns **two** classes precisely in the "close" branch (both clear the floor and
 * are within the mixed-domain margin). So the cascade fires where the deterministic
 * path would otherwise route *multi* — trying to resolve it to a single domain
 * before falling back to multi. Decisive (1) and abstain (0) pass through untouched,
 * and so does every case once the per-run budget is spent or no LLM is wired, so a
 * `cascade` run degrades cleanly to the deterministic Phase-A behavior.
 *
 * The LLM supplies only the *class* pick — its (miscalibrated) confidence is
 * ignored; the winner inherits the heuristic's combined mass for the tied pair.
 */
export class CascadeContentClassifier implements IContentClassifier {
  private escalationsUsed = 0;

  constructor(
    private readonly heuristic: IContentClassifier,
    private readonly llm: IContentClassifier | undefined,
    private readonly logger: Logger,
    private readonly maxEscalations: number = DEFAULT_MAX_ESCALATIONS
  ) {}

  async classify(
    content: string,
    path: string
  ): Promise<ClassificationResult[]> {
    const results = await this.heuristic.classify(content, path);

    // Only a top-2 tie (the gate's "close" branch) is worth an LLM call.
    const active = activeDomainClasses(results);
    if (active.length < 2) return results;

    if (!this.llm || this.escalationsUsed >= this.maxEscalations) {
      // No tie-break available → keep the calibrated-multi result (Phase-A behavior).
      return results;
    }

    this.escalationsUsed++;
    let pick: ContentClass | undefined;
    try {
      const llmResults = await this.llm.classify(content, path);
      pick = llmResults[0]?.class;
    } catch (err) {
      this.logger.warn(
        `Cascade LLM tie-break failed; keeping heuristic multi: ${err}`
      );
      this.traceEscalation(path, results, active, null);
      return results;
    }

    // Honor the LLM only when it picks one of the two tied candidates — a single
    // call must not promote a class the heuristic ranked far down.
    if (!pick || !active.includes(pick)) {
      this.logger.debug(
        `Cascade tie-break pick "${pick}" not in [${active.join(", ")}]; keeping heuristic multi`
      );
      this.traceEscalation(path, results, active, pick ?? null);
      return results;
    }

    const collapsed = this.collapseTie(results, active[0], active[1], pick);
    this.traceEscalation(path, collapsed, active, pick);
    return collapsed;
  }

  /**
   * Debug trace: record a cascade tie-break escalation (observe-only). Emitted
   * **once** per escalated chunk, with the *post-collapse* distribution so the
   * gate it reports matches what the run actually routed — a resolved tie reads
   * `single`, a kept-multi (failed/rejected pick) still reads `multi`.
   * `FileProcessor` deliberately skips its own classify event when the classifier
   * already emitted one (this is the escalated counterpart).
   */
  private traceEscalation(
    path: string,
    results: ClassificationResult[],
    active: ContentClass[],
    pick: ContentClass | null
  ): void {
    if (!trace.enabled) return;
    const post = activeDomainClasses(results);
    trace.emit({
      stage: "classify", type: "classification", file: path,
      distribution: results.map((r) => ({ class: r.class, confidence: r.confidence })),
      gate: post.length === 0 ? "abstain" : post.length === 1 ? "single" : "multi",
      activeClasses: post, escalated: true,
      tieBreak: { tied: [active[0], active[1]], pick },
    });
  }

  /**
   * Resolve a top-2 tie to `winner`: it absorbs the pair's combined confidence and
   * the other tied class is demoted to 0, so the downstream gate now routes a
   * single domain (`winner`).
   */
  private collapseTie(
    results: ClassificationResult[],
    a: ContentClass,
    b: ContentClass,
    winner: ContentClass
  ): ClassificationResult[] {
    const loser = winner === a ? b : a;
    const confA = results.find((r) => r.class === a)?.confidence ?? 0;
    const confB = results.find((r) => r.class === b)?.confidence ?? 0;
    this.logger.debug(`Cascade tie-break: ${a}/${b} → ${winner}`);

    return results
      .map((r) =>
        r.class === winner
          ? { ...r, confidence: confA + confB }
          : r.class === loser
          ? { ...r, confidence: 0 }
          : r
      )
      .sort((x, y) => y.confidence - x.confidence);
  }
}
