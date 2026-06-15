#!/usr/bin/env ts-node
/**
 * wanshi content-classifier accuracy report (A3)
 *
 * Runs the heuristic content classifier over the hand-labeled set in
 * `src/evaluation/classifier/labeledSamples.ts` and prints top-1 accuracy,
 * coverage, per-class precision/recall/F1, a confusion matrix, and the misses.
 *
 * This is the tuning loop for the classifier work (S2/S3/A1): change a weight or
 * threshold, re-run, watch the numbers. The same baseline is locked as a
 * regression test in `ClassifierAccuracy.test.ts`.
 *
 * Usage:
 *   npm run classifier-eval
 */

import { LoggerFactory } from "../src/shared";
import { HeuristicContentClassifier } from "../src/core/processor/classifier/HeuristicContentClassifier";
import {
  evaluateClassifier,
  formatReport,
  predictRouting,
  formatRouting,
} from "../src/evaluation/classifier/ClassifierAccuracy";
import { LABELED_SAMPLES } from "../src/evaluation/classifier/labeledSamples";

async function main() {
  // `error` level so the heuristic's per-class debug breakdown stays out of the report.
  const logger = LoggerFactory.createLogger({ logging: { level: "error" } });
  const classifier = new HeuristicContentClassifier(logger);

  const { rows, evaluation } = await evaluateClassifier(
    classifier,
    LABELED_SAMPLES
  );

  console.log(`\nheuristic classifier — ${LABELED_SAMPLES.length} labeled samples\n`);
  console.log(formatReport(evaluation, rows));

  const routing = await predictRouting(classifier, LABELED_SAMPLES);
  console.log("\n" + formatRouting(routing));
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
