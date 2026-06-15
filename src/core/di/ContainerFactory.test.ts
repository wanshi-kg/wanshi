import { ContainerFactory, TYPES } from "./index";
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
  it("rejects the unimplemented 'bert' classifier with a clear message", async () => {
    const container = ContainerFactory.createContainer({
      processingOptions: makeConfig({
        classifier: { mode: "bert" },
        logging: { level: "error", silent: true },
        llm: { model: "x", host: "y" },
      }),
    });

    await expect(container.resolve(TYPES.ContentClassifier)).rejects.toThrow(
      /bert.*not implemented/i
    );
  });
});
