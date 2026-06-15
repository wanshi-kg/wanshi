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
  it("rejects a removed/unknown classifier mode at config validation", () => {
    // `bert` (the old triple-guarded stub) is gone: the closed enum now rejects it
    // up front with the list of valid modes, instead of a deferred runtime throw.
    expect(() =>
      makeConfig({ classifier: { mode: "bert" } })
    ).toThrow();
  });
});

describe("ContainerFactory — pdfEngine dispatch", () => {
  const readerForPdf = async (pdfEngine?: string) => {
    const container = ContainerFactory.createContainer({
      processingOptions: makeConfig({
        readers: pdfEngine ? { pdfEngine } : {},
        logging: { level: "error", silent: true },
      }),
    });
    const factory = await container.resolve<any>(TYPES.FileReaderFactory);
    return factory.getReader("/corpus/datasheet.pdf")?.getName();
  };

  it("routes .pdf to pdf2json by default", async () => {
    expect(await readerForPdf()).toBe("PdfReader");
  });

  it.each([
    ["docling", "DoclingReader"],
    ["marker", "MarkerPdfReader"],
    ["mistral", "MistralOcrReader"],
  ])("routes .pdf to the %s reader", async (engine, expected) => {
    expect(await readerForPdf(engine)).toBe(expected);
  });

  it("keeps office docs on OfficeReader regardless of the PDF engine", async () => {
    const container = ContainerFactory.createContainer({
      processingOptions: makeConfig({
        readers: { pdfEngine: "docling" },
        logging: { level: "error", silent: true },
      }),
    });
    const factory = await container.resolve<any>(TYPES.FileReaderFactory);
    expect(factory.getReader("/corpus/report.docx")?.getName()).toBe("OfficeReader");
  });
});
