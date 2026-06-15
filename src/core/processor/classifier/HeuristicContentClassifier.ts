import { IContentClassifier } from "./IContentTypeClassifier";
import {
  ClassificationResult,
  ContentClass,
  ContentPattern,
  ContentClassConfig,
} from "../../../types";
import { CONTENT_CLASSES } from "./CONTENT_CLASSES";
import { Logger, softmax } from "../../../shared";


interface ClassConfigWithNegatives extends ContentClassConfig {
  negativePatterns: ContentPattern[];
}

/** Per-class raw score with its three contributions kept for debug/explainability. */
interface RawClassScore {
  class: ContentClass;
  fileScore: number;
  contentScore: number;
  negativeScore: number;
  total: number;
}

/**
 * Softmax temperature applied to the raw per-class scores to turn them into a
 * comparable distribution (S2). Lower = sharper (decisive single-domain); higher
 * = flatter (more ties → the cascade's "close" branch in `activeDomainClasses`).
 * Tuned on the A3 harness; overridable via `classifier.temperature` (A1).
 */
export const DEFAULT_SOFTMAX_TEMPERATURE = 2.0;

/**
 * Magnitude of the cross-validation penalty: each class subtracts every *other*
 * class's positive patterns at this fraction of their weight. Overridable via
 * `classifier.crossValidationFactor` (A1).
 */
export const DEFAULT_CROSS_VALIDATION_FACTOR = 0.15;

export class HeuristicContentClassifier implements IContentClassifier {
  private crossValidatedClasses: Record<string, ClassConfigWithNegatives> = {};

  constructor(
    private logger: Logger,
    private readonly temperature: number = DEFAULT_SOFTMAX_TEMPERATURE,
    private readonly crossValidationFactor: number = DEFAULT_CROSS_VALIDATION_FACTOR
  ) {
    this.initializeCrossValidation();
  }

  private initializeCrossValidation() {
    // For each class, collect ALL other classes positive patterns as negatives
    for (const [className, config] of Object.entries(CONTENT_CLASSES)) {
      const negativePatterns: ContentPattern[] = [];
      
      // Collect positive patterns from ALL other classes
      for (const [otherClassName, otherConfig] of Object.entries(CONTENT_CLASSES)) {
        if (otherClassName !== className) {
          // Add other classes positive patterns as negatives with reduced weight
          for (const pattern of otherConfig.contentPatterns) {
            negativePatterns.push({
              pattern: pattern.pattern,
              weight: -pattern.weight * this.crossValidationFactor, // negative, reduced magnitude
            });
          }
        }
      }

      this.crossValidatedClasses[className] = {
        ...config,
        negativePatterns
      };
    }
  }

  async classify(content: string, path: string): Promise<ClassificationResult[]> {
    const raw = Object.values(this.crossValidatedClasses).map((config) =>
      this.rawScore(content, path, config)
    );

    // Softmax over the raw scores → a comparable distribution across classes (S2),
    // not 12 independent squashes. We return *all* classes ranked and let the single
    // downstream gate (`activeDomainClasses`) decide abstain/single/multi — the old
    // `> 0.7` self-filter is gone (S3), so the classifier ranks and the consumer gates.
    const confidences = softmax(
      raw.map((r) => r.total),
      this.temperature
    );

    const results: ClassificationResult[] = raw.map((r, i) => ({
      class: r.class,
      confidence: confidences[i],
    }));

    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      this.logger.debug(
        `[heuristic] ${r.class}: file=${r.fileScore.toFixed(2)} content=${r.contentScore.toFixed(2)} ` +
          `neg=${r.negativeScore.toFixed(2)} total=${r.total.toFixed(2)} p=${confidences[i].toFixed(3)}`
      );
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  private rawScore(
    content: string,
    path: string,
    config: ClassConfigWithNegatives
  ): RawClassScore {
    // Track the three contributions separately so a debug run can explain *why*
    // a file scored the way it did (the seam for tuning weights/thresholds).
    let fileScore = 0;
    let contentScore = 0;
    let negativeScore = 0;

    // File pattern scoring
    for (const { pattern, weight } of config.filePatterns) {
      if (pattern.test(path)) {
        fileScore += weight;
      }
    }

    // Positive pattern scoring
    for (const { pattern, weight } of config.contentPatterns) {
      const matches = content.match(pattern) || [];
      const score = Math.log(matches.length + 1) * weight;
      if (score > 0) {
        contentScore += score;
      }
    }

    // Negative pattern scoring
    for (const { pattern, weight } of config.negativePatterns) {
      const matches = content.match(pattern) || [];
      const score = Math.log(matches.length + 1) * weight; // weight is negative
      if (score < 0) {
        negativeScore += score;
      }
    }

    return {
      class: config.name,
      fileScore,
      contentScore,
      negativeScore,
      total: fileScore + contentScore + negativeScore,
    };
  }
}
