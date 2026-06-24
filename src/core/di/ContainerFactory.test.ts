import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ContainerFactory, TYPES } from "./index";
import { makeConfig } from "../../__tests__/helpers";
import { domainGateThresholds, resetDomainGate } from "../knowledge/vocabulary";
import { trace } from "../trace";

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

describe("ContainerFactory — trace/cost sidecar path (WS-59)", () => {
  let tmp: string;
  afterEach(() => {
    trace.reset();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("bases the trace sidecar on the extension-rewritten graph path, not the raw --output stem", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgcf-"));
    const output = path.join(tmp, "kg.json"); // --output stem
    ContainerFactory.createContainer({
      processingOptions: makeConfig({
        output,
        export: { format: "jsonl" }, // mismatched ext → graph lands at kg.jsonl
        trace: { enabled: true },
        logging: { level: "error", silent: true },
      }),
    });
    // Emitting should write to kg.jsonl.trace.jsonl (resolved), NOT kg.json.trace.jsonl (raw).
    expect(trace.enabled).toBe(true);
    trace.emit({ stage: "export", type: "export", format: "jsonl", entities: 1, relations: 0 });
    expect(fs.existsSync(path.join(tmp, "kg.jsonl.trace.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "kg.json.trace.jsonl"))).toBe(false);
  });

  it("leaves the trace sidecar path unchanged when output ext == export format (byte-identical default)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgcf-"));
    const output = path.join(tmp, "kg.json");
    ContainerFactory.createContainer({
      processingOptions: makeConfig({
        output,
        export: { format: "json" }, // matches ext → no rewrite
        trace: { enabled: true },
        logging: { level: "error", silent: true },
      }),
    });
    trace.emit({ stage: "export", type: "export", format: "json", entities: 1, relations: 0 });
    expect(fs.existsSync(path.join(tmp, "kg.json.trace.jsonl"))).toBe(true);
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
