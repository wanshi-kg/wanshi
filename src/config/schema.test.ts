import {
  parseConfig,
  ConfigError,
  configJsonSchema,
  configSchemaPayload,
} from "./index";
import { cliArgsToConfig, deepMerge } from "../cli/optionsToConfig";

describe("config schema", () => {
  it("defaults the debug trace off", () => {
    expect(parseConfig({}).trace.enabled).toBe(false);
    expect(parseConfig({ trace: { enabled: true, path: "x.trace.jsonl" } }).trace.path).toBe("x.trace.jsonl");
  });

  it("defaults cost metering off and coerces maxCost + price overrides", () => {
    expect(parseConfig({}).cost.enabled).toBe(false);
    expect(parseConfig({}).cost.currency).toBe("USD");
    const c = parseConfig({ cost: { maxCost: "1.50", prices: { "my-model": { in: "2", out: "8" } } } });
    expect(c.cost.maxCost).toBe(1.5);
    expect(c.cost.prices["my-model"]).toEqual({ in: 2, out: 8 });
  });

  it("defaults the SQLite structured-emit adapter off with sensible defaults", () => {
    expect(parseConfig({}).adapters.sqlite.enabled).toBe(false);
    expect(parseConfig({}).adapters.sqlite.extensions).toEqual([".db", ".sqlite", ".sqlite3"]);
    expect(parseConfig({}).adapters.sqlite.maxRowsPerTable).toBe(5000);
    expect(parseConfig({ adapters: { sqlite: { maxRowsPerTable: "100" } } }).adapters.sqlite.maxRowsPerTable).toBe(100);
  });

  it("defaults the email reader (.eml/.mbox) knobs", () => {
    expect(parseConfig({}).readers.email.maxMessages).toBe(1000);
    expect(parseConfig({}).readers.email.stripQuotes).toBe(true);
    expect(parseConfig({ readers: { email: { maxMessages: "50" } } }).readers.email.maxMessages).toBe(50);
  });

  it("defaults the chat-export reader knobs", () => {
    expect(parseConfig({}).readers.chat.maxMessages).toBe(50000);
    expect(parseConfig({}).readers.chat.skipSystem).toBe(true);
    expect(parseConfig({ readers: { chat: { skipSystem: false } } }).readers.chat.skipSystem).toBe(false);
  });

  it("defaults the Jupyter reader knobs (outputs/images off)", () => {
    expect(parseConfig({}).readers.jupyter.includeOutputs).toBe(false);
    expect(parseConfig({}).readers.jupyter.includeImages).toBe(false);
    expect(parseConfig({ readers: { jupyter: { includeOutputs: true } } }).readers.jupyter.includeOutputs).toBe(true);
  });

  it("applies nested defaults from an empty config", () => {
    const c = parseConfig({});
    expect(c.input).toBe(".");
    expect(c.filter).toEqual(["**/*"]);
    expect(c.llm.model).toBe("llama3.2");
    expect(c.llm.provider).toBe("ollama");
    expect(c.llm.promptVersion).toBe("v5");
    expect(c.embeddings.model).toBe("nomic-embed-text");
    expect(c.chunking.size).toBe(2000);
    expect(c.chunking.overlap).toBe(100);
    expect(c.retrieval.scope).toBe("chunk");
    expect(c.export.format).toBe("json");
    expect(c.export.dot.layout).toBe("dot");
    expect(c.logging.level).toBe("info");
    expect(c.resume.enabled).toBe(false);
  });

  it("coerces CLI string numbers and a single filter string", () => {
    const c = parseConfig({ chunking: { size: "3000" }, filter: "**/*.ts" });
    expect(c.chunking.size).toBe(3000);
    expect(c.filter).toEqual(["**/*.ts"]);
  });

  it("maps a bare/empty numeric value to the default, not 0 (WS-19)", () => {
    // A YAML `size:` parses to null; an empty CLI value to "". Both must fall
    // through to the default rather than coercing to 0.
    expect(parseConfig({ chunking: { size: "" as any } }).chunking.size).toBe(2000);
    expect(parseConfig({ chunking: { size: null as any } }).chunking.size).toBe(2000);
    expect(parseConfig({ chunking: { overlap: "" as any } }).chunking.overlap).toBe(100);
    // a real 0 is a legitimate value and is preserved
    expect(parseConfig({ chunking: { overlap: 0 } }).chunking.overlap).toBe(0);
    // valid strings/numbers still coerce
    expect(parseConfig({ retrieval: { limit: "7" } }).retrieval.limit).toBe(7);
  });

  it("rejects an out-of-vocab enum value", () => {
    expect(() => parseConfig({ llm: { provider: "bogus" } })).toThrow(ConfigError);
  });

  it("rejects a legacy flat key and names the new nested path", () => {
    let message = "";
    try {
      parseConfig({ chunkSize: 2000 });
    } catch (e) {
      message = (e as ConfigError).message;
    }
    expect(message).toContain("chunkSize");
    expect(message).toContain("chunking.size");
    expect(message).toContain("MIGRATION.md");
  });

  it("defaults the PDF engine to pdf2json and round-trips marker/mistral config", () => {
    expect(parseConfig({}).readers.pdfEngine).toBe("pdf2json");
    const c = parseConfig({
      readers: { pdfEngine: "marker", marker: { useLlm: true }, mistral: { model: "mistral-ocr-2512" } },
    });
    expect(c.readers.pdfEngine).toBe("marker");
    expect(c.readers.marker.useLlm).toBe(true);
    expect(c.readers.marker.command).toBe("marker_single");
    expect(c.readers.mistral.host).toBe("https://api.mistral.ai");
    expect(c.readers.mistral.model).toBe("mistral-ocr-2512");
  });

  it("defaults the tesseract OCR engine knobs and accepts the engine value", () => {
    expect(parseConfig({}).readers.tesseract.lang).toBe("eng");
    expect(parseConfig({}).readers.tesseract.scale).toBe(2);
    const c = parseConfig({ readers: { pdfEngine: "tesseract", tesseract: { lang: "eng+deu", psm: "6" } } });
    expect(c.readers.pdfEngine).toBe("tesseract");
    expect(c.readers.tesseract.lang).toBe("eng+deu");
    expect(c.readers.tesseract.psm).toBe(6);
  });

  it("defaults the chandra OCR engine knobs and accepts the engine value", () => {
    expect(parseConfig({}).readers.chandra.command).toBe("chandra");
    expect(parseConfig({}).readers.chandra.method).toBe("hf");
    const c = parseConfig({ readers: { pdfEngine: "chandra", chandra: { method: "vllm" } } });
    expect(c.readers.pdfEngine).toBe("chandra");
    expect(c.readers.chandra.method).toBe("vllm");
  });

  it("defaults image EXIF extraction off", () => {
    expect(parseConfig({}).readers.exif.enabled).toBe(false);
    expect(parseConfig({ readers: { exif: { enabled: true } } }).readers.exif.enabled).toBe(true);
  });

  it("defaults the C2PA read off with the c2patool command", () => {
    expect(parseConfig({}).readers.c2pa.enabled).toBe(false);
    expect(parseConfig({}).readers.c2pa.command).toBe("c2patool");
    expect(parseConfig({ readers: { c2pa: { enabled: true } } }).readers.c2pa.enabled).toBe(true);
  });

  it("defaults the CV object-detection pre-pass off (closed mode)", () => {
    expect(parseConfig({}).readers.cv.detection.enabled).toBe(false);
    expect(parseConfig({}).readers.cv.detection.mode).toBe("closed");
    expect(parseConfig({}).readers.cv.detection.threshold).toBe(0.5);
    const c = parseConfig({ readers: { cv: { detection: { enabled: true, mode: "zero-shot", labels: ["tank"] } } } });
    expect(c.readers.cv.detection.mode).toBe("zero-shot");
    expect(c.readers.cv.detection.labels).toEqual(["tank"]);
  });

  it("migrates the retired readers.docling key to readers.pdfEngine", () => {
    let message = "";
    try {
      parseConfig({ readers: { docling: true } });
    } catch (e) {
      message = (e as ConfigError).message;
    }
    expect(message).toContain("docling");
    expect(message).toContain("readers.pdfEngine");
  });

  it("resolves precedence defaults < file < CLI", () => {
    const file = { llm: { model: "file-model", host: "file-host" } };
    const cli = cliArgsToConfig({ model: "cli-model" });
    const c = parseConfig(deepMerge(file, cli));
    // CLI overrides the file value...
    expect(c.llm.model).toBe("cli-model");
    // ...but a file-only sibling survives the deep merge.
    expect(c.llm.host).toBe("file-host");
  });

  it("defaults the canonicalization-experiment groups (stages off)", () => {
    const c = parseConfig({});
    expect(c.pipeline.stages).toEqual([
      "tf_analysis",
      "schema_induction",
      "extraction",
      "grounding",
      "canonicalization",
    ]);
    // Extraction defaults to the closed vocabulary (open-predicate is opt-in).
    expect(c.pipeline.extraction.enabled).toBe(true);
    expect(c.pipeline.extraction.openPredicate).toBe(false);
    // Both new graph→transform stages are OFF by default → baseline behavior.
    expect(c.pipeline.grounding.enabled).toBe(false);
    expect(c.pipeline.grounding.requireCooccurrence).toBe(true);
    expect(c.pipeline.canonicalization.enabled).toBe(false);
    expect(c.pipeline.canonicalization.method).toBe("embeddings");
    expect(c.pipeline.canonicalization.embeddings.entity.threshold).toBe(0.82);
    expect(c.pipeline.canonicalization.embeddings.relation.threshold).toBe(0.85);
    expect(c.pipeline.canonicalization.canonicalSelection).toBe("frequency");
    expect(c.inspection.emitMergeLog).toBe(false);
    expect(c.eval.pinVersions).toBe(true);
  });

  it("coerces canonicalization thresholds and rejects a bad cluster algo", () => {
    const c = parseConfig({
      pipeline: { canonicalization: { embeddings: { entity: { threshold: "0.9" } } } },
    });
    expect(c.pipeline.canonicalization.embeddings.entity.threshold).toBe(0.9);
    expect(() =>
      parseConfig({ pipeline: { canonicalization: { method: "telepathy" } } })
    ).toThrow(ConfigError);
  });

  it("exposes a JSON Schema + UI groups for the frontend", () => {
    const schema = configJsonSchema() as any;
    const props = schema.properties ?? schema.definitions?.KgGenConfig?.properties;
    expect(props).toBeDefined();
    expect(props.llm).toBeDefined();
    expect(props.chunking).toBeDefined();

    const payload = configSchemaPayload();
    expect(payload.jsonSchema).toBeDefined();
    expect(payload.groups.length).toBeGreaterThan(0);
    expect(payload.groups.some((g) => g.id === "generation")).toBe(true);
    expect(payload.controlledPaths).toContain("resume.enabled");
  });
});
