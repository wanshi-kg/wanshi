import { ContainerFactory } from "./index";
import { makeConfig } from "../../__tests__/helpers";
import { domainGateThresholds, resetDomainGate } from "../knowledge/vocabulary";

describe("ContainerFactory — domain-gate config (A1)", () => {
  afterEach(() => resetDomainGate());

  it("applies classifier thresholds to the run-global gate", () => {
    ContainerFactory.createContainer({
      processingOptions: makeConfig({
        classifier: { lowConfidenceThreshold: 0.4, mixedDomainThreshold: 0.05 },
        logging: { level: "error", silent: true },
      }),
    });
    expect(domainGateThresholds()).toEqual({ lowConfidence: 0.4, mixedDomain: 0.05 });
  });

  it("falls back to the default thresholds when unset", () => {
    ContainerFactory.createContainer({
      processingOptions: makeConfig({ logging: { level: "error", silent: true } }),
    });
    expect(domainGateThresholds()).toEqual({ lowConfidence: 0.25, mixedDomain: 0.15 });
  });
});

describe("ContainerFactory — classifier gating", () => {
  it("rejects a removed/unknown classifier mode at config validation", () => {
    // `bert` (the old triple-guarded stub) is gone: the closed enum now rejects it
    // up front with the list of valid modes, instead of a deferred runtime throw.
    expect(() =>
      makeConfig({ classifier: { mode: "bert" } })
    ).toThrow();
  });
});
