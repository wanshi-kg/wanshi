import { ContentClass, ClassificationResult } from "../../types";
import { IContentClassifier } from "../../core/processor/classifier/IContentTypeClassifier";
import { activeDomainClasses } from "../../core/knowledge/vocabulary";
import { EvalMetrics } from "../datasets/IDataset";
import { computeMetrics } from "../metrics/TripleMetrics";
import { LabeledSample } from "./labeledSamples";

/**
 * Classifier-accuracy harness (A3).
 *
 * Runs a content classifier over a hand-labeled set and reports top-1 accuracy,
 * coverage (how often it predicts anything at all — the heuristic filters at >0.7,
 * so it can abstain), per-class precision/recall/F1, macro-F1, and a confusion
 * matrix. This is the falsifiable target the S2/S3/A1 work is missing today.
 *
 * Metric reuse: per-class P/R/F1 comes from the same {@link computeMetrics}
 * (tp/fp/fn) the triple-extraction benchmark uses.
 */

/** Sentinel column for "classifier abstained / returned no class above threshold". */
export const NO_PREDICTION = "∅";

export interface PredictionRow {
  id: string;
  expected: ContentClass;
  predicted: ContentClass | null;
  confidence: number | null;
}

export interface ClassifierEvaluation {
  total: number;
  /** Samples that received a top-1 prediction (cleared the classifier's threshold). */
  predictedCount: number;
  correct: number;
  /** correct / total — abstentions count as misses. */
  top1Accuracy: number;
  /** predictedCount / total — how often the classifier committed to a class. */
  coverage: number;
  /** Mean per-class F1 over the classes present in the gold labels. */
  macroF1: number;
  perClass: Record<string, EvalMetrics>;
  /** gold class → (predicted class | NO_PREDICTION) → count. */
  confusion: Record<string, Record<string, number>>;
}

/** Top-1 of a classifier's ranked results (null when it returned nothing). */
export function top1(
  results: ClassificationResult[]
): { cls: ContentClass | null; confidence: number | null } {
  const top = results[0];
  return top
    ? { cls: top.class, confidence: top.confidence }
    : { cls: null, confidence: null };
}

/** Classify every sample and collect its top-1 prediction. */
export async function predict(
  classifier: IContentClassifier,
  samples: LabeledSample[]
): Promise<PredictionRow[]> {
  const rows: PredictionRow[] = [];
  for (const s of samples) {
    const results = await classifier.classify(s.content, s.path);
    const { cls, confidence } = top1(results);
    rows.push({ id: s.id, expected: s.expected, predicted: cls, confidence });
  }
  return rows;
}

/** Pure: turn prediction rows into accuracy + per-class P/R/F1 + confusion. */
export function evaluate(rows: PredictionRow[]): ClassifierEvaluation {
  const goldClasses = Array.from(new Set(rows.map((r) => r.expected)));

  const perClass: Record<string, EvalMetrics> = {};
  for (const c of goldClasses) {
    const tp = rows.filter((r) => r.expected === c && r.predicted === c).length;
    const fp = rows.filter((r) => r.expected !== c && r.predicted === c).length;
    const fn = rows.filter((r) => r.expected === c && r.predicted !== c).length;
    perClass[c] = computeMetrics(tp, fp, fn);
  }

  const total = rows.length;
  const correct = rows.filter((r) => r.predicted === r.expected).length;
  const predictedCount = rows.filter((r) => r.predicted !== null).length;
  const f1s = goldClasses.map((c) => perClass[c].f1);
  const macroF1 = f1s.length
    ? f1s.reduce((a, b) => a + b, 0) / f1s.length
    : 0;

  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const g = r.expected;
    const p = r.predicted ?? NO_PREDICTION;
    (confusion[g] ??= {})[p] = (confusion[g][p] ?? 0) + 1;
  }

  return {
    total,
    predictedCount,
    correct,
    top1Accuracy: total ? correct / total : 0,
    coverage: total ? predictedCount / total : 0,
    macroF1,
    perClass,
    confusion,
  };
}

/** Convenience: predict + evaluate in one call. */
export async function evaluateClassifier(
  classifier: IContentClassifier,
  samples: LabeledSample[]
): Promise<{ rows: PredictionRow[]; evaluation: ClassifierEvaluation }> {
  const rows = await predict(classifier, samples);
  return { rows, evaluation: evaluate(rows) };
}

// ─── Routing eval (the S2 effect: does the *gate* pick the right domain?) ──────
//
// Top-1 accuracy only sees the argmax; it can't tell whether the calibrated
// confidence makes `activeDomainClasses` route the right domain(s). This measures
// the end-to-end decision the prompt actually consumes.

export interface RoutingRow {
  id: string;
  expected: ContentClass;
  activated: ContentClass[]; // what activeDomainClasses() returns (abstain=[] )
  p1: number;
  p2: number;
}

export interface RoutingEvaluation {
  total: number;
  /** activated === exactly [expected] — the decisive, correctly-single case. */
  exactSingle: number;
  /** expected ∈ activated (single or multi both count). */
  recalled: number;
  /** activated.length === 0 — the gate abstained. */
  abstained: number;
  exactSingleRate: number;
  recallRate: number;
}

export async function predictRouting(
  classifier: IContentClassifier,
  samples: LabeledSample[]
): Promise<RoutingRow[]> {
  const rows: RoutingRow[] = [];
  for (const s of samples) {
    const results = await classifier.classify(s.content, s.path);
    const sorted = [...results].sort((a, b) => b.confidence - a.confidence);
    rows.push({
      id: s.id,
      expected: s.expected,
      activated: activeDomainClasses(results),
      p1: sorted[0]?.confidence ?? 0,
      p2: sorted[1]?.confidence ?? 0,
    });
  }
  return rows;
}

export function evaluateRouting(rows: RoutingRow[]): RoutingEvaluation {
  const total = rows.length;
  const exactSingle = rows.filter(
    (r) => r.activated.length === 1 && r.activated[0] === r.expected
  ).length;
  const recalled = rows.filter((r) => r.activated.includes(r.expected)).length;
  const abstained = rows.filter((r) => r.activated.length === 0).length;
  return {
    total,
    exactSingle,
    recalled,
    abstained,
    exactSingleRate: total ? exactSingle / total : 0,
    recallRate: total ? recalled / total : 0,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Per-sample routing dump — the tuning view for the temperature + gate knobs. */
export function formatRouting(rows: RoutingRow[]): string {
  const ev = evaluateRouting(rows);
  const lines: string[] = [];
  lines.push(
    `routing: exact-single ${pct(ev.exactSingleRate)} (${ev.exactSingle}/${ev.total})   ` +
      `recall ${pct(ev.recallRate)}   abstained ${ev.abstained}`
  );
  lines.push("");
  lines.push("sample            expected        activated                p1     p2    margin");
  lines.push("────────────────  ──────────────  ───────────────────────  ─────  ─────  ──────");
  for (const r of rows) {
    const ok = r.activated.length === 1 && r.activated[0] === r.expected ? " " : "!";
    lines.push(
      `${ok} ${r.id.padEnd(16)} ${r.expected.padEnd(14)} ${r.activated.join(",").padEnd(23)}` +
        ` ${r.p1.toFixed(3)}  ${r.p2.toFixed(3)}  ${(r.p1 - r.p2).toFixed(3)}`
    );
  }
  return lines.join("\n");
}

/** Human-readable report for the tuning loop (printed by scripts/classifier-eval.ts). */
export function formatReport(
  evaluation: ClassifierEvaluation,
  rows?: PredictionRow[]
): string {
  const { perClass, confusion } = evaluation;
  const lines: string[] = [];

  lines.push(
    `top-1 accuracy: ${pct(evaluation.top1Accuracy)}  ` +
      `(${evaluation.correct}/${evaluation.total})   ` +
      `coverage: ${pct(evaluation.coverage)}   ` +
      `macro-F1: ${evaluation.macroF1.toFixed(3)}`
  );
  lines.push("");
  lines.push("class            precision  recall    f1     support");
  lines.push("───────────────  ─────────  ──────  ──────  ───────");
  for (const cls of Object.keys(perClass).sort()) {
    const m = perClass[cls];
    const support = m.tp + m.fn;
    lines.push(
      `${cls.padEnd(15)}  ${pct(m.precision).padStart(9)}  ${pct(m.recall).padStart(6)}  ${m.f1.toFixed(3).padStart(6)}  ${String(support).padStart(7)}`
    );
  }

  lines.push("");
  lines.push("confusion (gold → predicted):");
  for (const gold of Object.keys(confusion).sort()) {
    const preds = Object.entries(confusion[gold])
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p}×${n}`)
      .join(", ");
    lines.push(`  ${gold.padEnd(15)} → ${preds}`);
  }

  if (rows) {
    const misses = rows.filter((r) => r.predicted !== r.expected);
    if (misses.length) {
      lines.push("");
      lines.push("misses:");
      for (const r of misses) {
        lines.push(
          `  ${r.id.padEnd(16)} expected ${r.expected}, got ${r.predicted ?? NO_PREDICTION}` +
            (r.confidence != null ? ` (conf ${r.confidence.toFixed(2)})` : "")
        );
      }
    }
  }

  return lines.join("\n");
}
