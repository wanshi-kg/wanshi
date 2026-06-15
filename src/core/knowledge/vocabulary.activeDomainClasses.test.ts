import {
  activeDomainClasses,
  configureDomainGate,
  resetDomainGate,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_MIXED_DOMAIN_THRESHOLD,
} from "./vocabulary";
import { ClassificationResult, ContentClass } from "../../types";

/** Build a synthetic softmax-style result list. */
const dist = (entries: [ContentClass, number][]): ClassificationResult[] =>
  entries.map(([cls, confidence]) => ({ class: cls, confidence }));

describe("activeDomainClasses — confidence cascade (S2/S3)", () => {
  it("abstains on a flat distribution (top below the floor)", () => {
    expect(
      activeDomainClasses(
        dist([
          ["code", 0.12],
          ["documentation", 0.1],
          ["narrative", 0.09],
        ])
      )
    ).toEqual([]);
  });

  it("routes a single decisive domain", () => {
    expect(
      activeDomainClasses(dist([["code", 0.8], ["documentation", 0.1]]))
    ).toEqual(["code"]);
  });

  it("stays single when the second domain clears the floor but is not a tie", () => {
    expect(
      activeDomainClasses(dist([["code", 0.55], ["documentation", 0.3]]))
    ).toEqual(["code"]);
  });

  it("stays single when a close second is below the floor", () => {
    expect(
      activeDomainClasses(dist([["code", 0.45], ["documentation", 0.2]]))
    ).toEqual(["code"]);
  });

  it("activates both when two domains co-dominate (close + both above floor)", () => {
    expect(
      activeDomainClasses(dist([["code", 0.42], ["documentation", 0.34]]))
    ).toEqual(["code", "documentation"]);
  });

  it("returns [] for empty / undefined input", () => {
    expect(activeDomainClasses([])).toEqual([]);
    expect(activeDomainClasses(undefined)).toEqual([]);
  });

  it("sorts internally (unsorted input still picks the true top)", () => {
    expect(
      activeDomainClasses(dist([["documentation", 0.1], ["code", 0.8]]))
    ).toEqual(["code"]);
  });

  it("fixtures stay consistent with the default thresholds", () => {
    expect(0.42 - 0.34).toBeLessThanOrEqual(DEFAULT_MIXED_DOMAIN_THRESHOLD); // close → multi
    expect(0.55 - 0.3).toBeGreaterThan(DEFAULT_MIXED_DOMAIN_THRESHOLD); // gap → single
    expect(0.2).toBeLessThan(DEFAULT_LOW_CONFIDENCE_THRESHOLD); // p2 below floor
    expect(0.12).toBeLessThan(DEFAULT_LOW_CONFIDENCE_THRESHOLD); // flat top → abstain
  });
});

describe("configureDomainGate — run-global gate thresholds (A1)", () => {
  afterEach(() => resetDomainGate());

  it("a raised floor abstains where the default would route", () => {
    const d = dist([["code", 0.3], ["documentation", 0.05]]);
    expect(activeDomainClasses(d)).toEqual(["code"]); // default floor 0.25
    configureDomainGate({ lowConfidence: 0.4 });
    expect(activeDomainClasses(d)).toEqual([]); // 0.30 < 0.40 → abstain
  });

  it("a widened margin co-activates a second domain that was single by default", () => {
    const d = dist([["code", 0.55], ["documentation", 0.3]]);
    expect(activeDomainClasses(d)).toEqual(["code"]); // gap 0.25 > default 0.15
    configureDomainGate({ mixedDomain: 0.3 });
    expect(activeDomainClasses(d)).toEqual(["code", "documentation"]); // 0.25 ≤ 0.30
  });

  it("resetDomainGate restores the defaults", () => {
    configureDomainGate({ lowConfidence: 0.9, mixedDomain: 0.0 });
    resetDomainGate();
    const d = dist([["code", 0.3], ["documentation", 0.05]]);
    expect(activeDomainClasses(d)).toEqual(["code"]);
  });
});
