import { ClassificationResult, ContentClass } from '../../types';
import { NER_DOMAIN_EXAMPLES } from '../processor/classifier/NER_DOMAIN_EXAMPLES';

/**
 * Single source of truth for the v5 closed vocabularies (KG-05).
 *
 * The base sets mirror the `{{else}}` lists in `templates/v5/system.hbs`
 * (a test in `vocabulary.test.ts` asserts they stay equal), and the same
 * `allowed*` helpers feed *both* the Zod enum (`KnowledgeGraphBuilder`) and the
 * prompt hints (`PromptManager.buildDomainHints`) — so the enum, the hints, and
 * the gold examples can never drift into the three-way disagreement KG-05
 * describes (entity enum scoped to a domain, relation enum not).
 */

/**
 * Domain-agnostic entity types, always offered alongside any detected domain's
 * vocabulary, plus an `other` escape hatch so the model is never forced to
 * mislabel when nothing fits.
 */
export const BASE_ENTITY_TYPES = [
  "person", "organization", "location", "role", "event", "time", "metric",
  "concept", "term", "document", "product", "technology", "standard",
  "class", "interface", "function", "module", "service", "dependency",
  "data_structure", "config", "file",
];

/** Base relation predicates, always offered alongside any detected domain. */
export const BASE_RELATION_TYPES = [
  "uses", "depends_on", "calls", "implements", "extends", "contains", "part_of",
  "produces", "consumes", "configures", "references", "defines", "targets",
  "located_in", "works_at", "member_of", "precedes", "causes", "has_attribute",
  "related_to",
];

/** Escape hatches: keep the model from being forced to invent a one-off label. */
export const ENTITY_TYPE_ESCAPE = "other";
export const RELATION_TYPE_ESCAPE = "related_to";

/**
 * Default minimum top-1 confidence to treat a classification as a domain signal.
 *
 * Calibrated for the softmax-probability confidences both classifiers now emit
 * (S2): ~3× the 1/12 uniform baseline (≈0.083). A clearly-dominant-but-weak class
 * (e.g. financial prose with no `$` smoking-gun lands at ~0.31, next at ~0.07)
 * still routes; a flat/uniform distribution (garbage or empty content, p1 ≲ 0.15)
 * abstains. The pre-S2 value (0.3) was tuned for the old *independent* tanh scores.
 */
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.25;

/**
 * Default max top1−top2 probability gap that still counts as a tie → activate both.
 * Conservative on purpose: combined with the floor on the *second* class, multi
 * only fires when two domains genuinely co-dominate (each ≥ floor and within this
 * margin), which prevents the "doubling the enum" over-activation S2 flagged. The
 * pre-S2 value (0.2) was tuned for tanh scores.
 */
export const DEFAULT_MIXED_DOMAIN_THRESHOLD = 0.15;

/**
 * Run-global domain-gate thresholds (A1). A module singleton — like
 * `shared/shutdown.ts` — set once per run from
 * `classifier.{lowConfidenceThreshold,mixedDomainThreshold}` by `ContainerFactory`.
 *
 * Keeping it module-global (rather than threading config through every pure gate
 * function) guarantees the Zod enum path, the prompt hints, the cascade, and the
 * eval harness all gate on **identical** thresholds — the KG-05 single-source
 * invariant that would otherwise be one missed caller away from divergence.
 */
let lowConfidenceThreshold = DEFAULT_LOW_CONFIDENCE_THRESHOLD;
let mixedDomainThreshold = DEFAULT_MIXED_DOMAIN_THRESHOLD;

/** Override the gate thresholds for this run; `undefined` values keep the current. */
export function configureDomainGate(opts: {
  lowConfidence?: number;
  mixedDomain?: number;
}): void {
  if (typeof opts.lowConfidence === "number") lowConfidenceThreshold = opts.lowConfidence;
  if (typeof opts.mixedDomain === "number") mixedDomainThreshold = opts.mixedDomain;
}

/** The active gate thresholds (read by `activeDomainClasses` and `getTopClass`). */
export function domainGateThresholds(): {
  lowConfidence: number;
  mixedDomain: number;
} {
  return { lowConfidence: lowConfidenceThreshold, mixedDomain: mixedDomainThreshold };
}

/** Restore the default thresholds — for tests that exercise a custom gate config. */
export function resetDomainGate(): void {
  lowConfidenceThreshold = DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  mixedDomainThreshold = DEFAULT_MIXED_DOMAIN_THRESHOLD;
}

/**
 * The deterministic confidence cascade (S2/S3): the domain class(es) a
 * classification activates from a calibrated softmax distribution —
 *
 *   - **abstain** (`[]`)      when the top class is below the low-confidence floor;
 *   - **single** (`[c1]`)     when one class clears the floor and dominates;
 *   - **multi**  (`[c1, c2]`) when a close second also clears the floor, within
 *                             the mixed-domain margin.
 *
 * Thresholds come from the run-global {@link domainGateThresholds}. This is the
 * *one* selection both the Zod enum and the prompt hints use, so they can't
 * disagree about which domain is active. (Phase B inserts an LLM tie-break into
 * the "close" branch before falling through to multi.)
 */
export function activeDomainClasses(
  contentClasses?: ClassificationResult[]
): ContentClass[] {
  if (!contentClasses || contentClasses.length === 0) return [];
  const sorted = [...contentClasses].sort((a, b) => b.confidence - a.confidence);
  const top = sorted[0];
  if (top.confidence < lowConfidenceThreshold) return [];
  const active: ContentClass[] = [top.class];
  if (
    sorted.length > 1 &&
    sorted[1].confidence >= lowConfidenceThreshold &&
    top.confidence - sorted[1].confidence <= mixedDomainThreshold
  ) {
    active.push(sorted[1].class);
  }
  return active;
}

/**
 * The union of primary entity/relation types across the active domain class(es),
 * in active-class order. Empty when no class clears the threshold.
 */
export function domainVocabulary(
  contentClasses?: ClassificationResult[]
): { entityTypes: string[]; relationTypes: string[] } {
  const entityTypes: string[] = [];
  const relationTypes: string[] = [];
  for (const cls of activeDomainClasses(contentClasses)) {
    const ner = NER_DOMAIN_EXAMPLES[cls];
    if (!ner) continue;
    entityTypes.push(...ner.primaryEntityTypes);
    relationTypes.push(...ner.primaryRelationTypes);
  }
  return { entityTypes, relationTypes };
}

/**
 * Closed entity-type set for the Zod enum: active-domain primary types ∪ corpus
 * glossary types ∪ base set ∪ `other`. Always non-empty (the base set is the
 * floor), so `entityType` is an enforced enum even with no class and no glossary.
 */
export function allowedEntityTypes(
  contentClasses?: ClassificationResult[],
  glossaryTypes: string[] = []
): string[] {
  return Array.from(
    new Set([
      ...domainVocabulary(contentClasses).entityTypes,
      ...glossaryTypes,
      ...BASE_ENTITY_TYPES,
      ENTITY_TYPE_ESCAPE,
    ])
  );
}

/**
 * Closed relation-predicate set for the Zod enum: active-domain primary
 * predicates ∪ corpus glossary predicates ∪ base set ∪ `related_to`. Unlike the
 * pre-Phase-2 resolver this DOES include the domain predicates, closing the
 * KG-05 gap where the relation enum excluded exactly the predicates the hints
 * and gold examples taught.
 */
export function allowedRelationTypes(
  contentClasses?: ClassificationResult[],
  glossaryTypes: string[] = []
): string[] {
  return Array.from(
    new Set([
      ...domainVocabulary(contentClasses).relationTypes,
      ...glossaryTypes,
      ...BASE_RELATION_TYPES,
      RELATION_TYPE_ESCAPE,
    ])
  );
}
