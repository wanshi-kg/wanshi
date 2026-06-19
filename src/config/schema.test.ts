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
    expect(c.embeddings.model).toBe("mxbai-embed-large:335m");
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
