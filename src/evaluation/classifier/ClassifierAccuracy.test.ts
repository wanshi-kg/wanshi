import {
  evaluate,
  evaluateClassifier,
  predictRouting,
  evaluateRouting,
  NO_PREDICTION,
  PredictionRow,
} from "./ClassifierAccuracy";
import { LABELED_SAMPLES } from "./labeledSamples";
import { HeuristicContentClassifier } from "../../core/processor/classifier/HeuristicContentClassifier";
import { stubLogger } from "../../__tests__/helpers";

describe("evaluate() — classifier metrics (A3)", () => {
  it("computes per-class P/R/F1, accuracy, coverage, and confusion", () => {
    const rows: PredictionRow[] = [
      { id: "a", expected: "code", predicted: "code", confidence: 0.9 },
      { id: "b", expected: "code", predicted: "medical", confidence: 0.8 },
      { id: "c", expected: "medical", predicted: "medical", confidence: 0.9 },
      { id: "d", expected: "medical", predicted: null, confidence: null }, // abstain
    ];

    const ev = evaluate(rows);

    // code: tp=1, fp=0, fn=1
    expect(ev.perClass.code.precision).toBeCloseTo(1.0);
    expect(ev.perClass.code.recall).toBeCloseTo(0.5);
    expect(ev.perClass.code.f1).toBeCloseTo(0.667, 2);
    // medical: tp=1, fp=1 (b misclassified as medical), fn=1 (d abstained)
    expect(ev.perClass.medical.precision).toBeCloseTo(0.5);
    expect(ev.perClass.medical.recall).toBeCloseTo(0.5);

    expect(ev.top1Accuracy).toBeCloseTo(0.5); // a, c correct of 4
    expect(ev.coverage).toBeCloseTo(0.75); // d abstained
    expect(ev.macroF1).toBeCloseTo((0.667 + 0.5) / 2, 2);

    // abstention is recorded as a miss, not a wrong-class prediction
    expect(ev.confusion.medical[NO_PREDICTION]).toBe(1);
    expect(ev.confusion.code.medical).toBe(1);
  });
});

describe("heuristic classifier accuracy on the labeled set (A3 / S2+S3 target)", () => {
  // Ratcheted up after S2/S3: softmax calibration + dropping the >0.7 filter
  // resolved the two ex-abstentions (financial prose, markdown pipe-table), so the
  // heuristic now argmax-classifies and routes every labeled sample. Floors carry
  // ~1-sample slack; tighten further as the labeled set grows.
  const MIN_TOP1_ACCURACY = 0.97; // currently 36/36 = 1.0
  const MIN_MACRO_F1 = 0.97;
  const MIN_EXACT_SINGLE = 0.97; // activeDomainClasses routes exactly [expected]

  it("meets the top-1 accuracy / macro-F1 floor and always commits", async () => {
    const classifier = new HeuristicContentClassifier(stubLogger());
    const { evaluation } = await evaluateClassifier(classifier, LABELED_SAMPLES);

    expect(evaluation.total).toBe(LABELED_SAMPLES.length);
    expect(evaluation.top1Accuracy).toBeGreaterThanOrEqual(MIN_TOP1_ACCURACY);
    expect(evaluation.macroF1).toBeGreaterThanOrEqual(MIN_MACRO_F1);
    // The classifier ranks all classes now — abstention moved to the gate (S3).
    expect(evaluation.coverage).toBe(1);
  });

  it("routes the right single domain through the gate, no abstentions (S2)", async () => {
    const classifier = new HeuristicContentClassifier(stubLogger());
    const rows = await predictRouting(classifier, LABELED_SAMPLES);
    const routing = evaluateRouting(rows);

    expect(routing.exactSingleRate).toBeGreaterThanOrEqual(MIN_EXACT_SINGLE);
    expect(routing.abstained).toBe(0); // no legitimate single-domain sample abstains
  });

  it("never predicts a class outside the ContentClass taxonomy", async () => {
    const classifier = new HeuristicContentClassifier(stubLogger());
    const { rows } = await evaluateClassifier(classifier, LABELED_SAMPLES);
    const taxonomy = new Set(LABELED_SAMPLES.map((s) => s.expected));
    for (const r of rows) {
      if (r.predicted !== null) expect(taxonomy.has(r.predicted)).toBe(true);
    }
  });
});
