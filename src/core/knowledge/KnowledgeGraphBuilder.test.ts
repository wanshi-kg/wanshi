import { KnowledgeGraphBuilder } from "./KnowledgeGraphBuilder";
import { stubLogger } from "../../__tests__/helpers";

/**
 * Read a closed-vocab enum's allowed values from the captured schema. The enum is
 * wrapped in `.catch(escape)` (lenient coercion of out-of-vocab values), so the node
 * is a ZodCatch — unwrap `_def.innerType` to reach the ZodEnum's `.options`.
 */
const enumOptions = (node: any): string[] | undefined => (node?._def?.innerType ?? node)?.options;

describe("KnowledgeGraphBuilder", () => {
  function makeBuilder(captured: any[]) {
    const promptManager = {
      getUserPrompt: async (ctx: any) => {
        captured.push(ctx);
        return "user-prompt";
      },
      getSystemPrompt: async () => "system",
    } as any;
    const llmService = {
      generateStructured: async () => ({ entities: [], relations: [] }),
      getModelCapabilities: async () => [],
    } as any;
    return new KnowledgeGraphBuilder(
      { llmService, promptManager, model: "m" },
      stubLogger()
    );
  }

  it("threads full file content into the prompt context for multi-chunk files", async () => {
    const captured: any[] = [];
    const builder = makeBuilder(captured);

    const processedFile = {
      path: "f.txt",
      content: "FULL FILE TEXT",
      chunks: [
        { content: "chunk one", index: 1, totalChunks: 2, startOffset: 0, endOffset: 9 },
        { content: "chunk two", index: 2, totalChunks: 2, startOffset: 9, endOffset: 18 },
      ],
    } as any;

    const graphs = await builder.build(processedFile, "system");

    // one graph produced per chunk (mocked end-to-end through the LLM stub)
    expect(graphs).toHaveLength(2);
    // every chunk's prompt context carried the full file text for grounding/outline
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => c.fileContent === "FULL FILE TEXT")).toBe(true);
    expect(captured[0].chunkContent).toBe("chunk one");
    expect(captured[1].chunkContent).toBe("chunk two");
  });

  it("scopes entityType to a per-domain Zod enum when a content class is detected", async () => {
    let capturedSchema: any;
    const promptManager = {
      getUserPrompt: async () => "u",
      getSystemPrompt: async () => "s",
    } as any;
    const llmService = {
      generateStructured: async (_m: any, schema: any) => {
        capturedSchema = schema;
        return { entities: [], relations: [] };
      },
      getModelCapabilities: async () => [],
    } as any;
    const builder = new KnowledgeGraphBuilder(
      { llmService, promptManager, model: "m" },
      stubLogger()
    );

    const processedFile = {
      path: "f.ts",
      content: "x",
      metadata: { classes: [{ class: "code", confidence: 0.9 }] },
      chunks: [{ content: "c", index: 1, totalChunks: 1, startOffset: 0, endOffset: 1 }],
    } as any;

    await builder.build(processedFile, "s");

    const entityType = capturedSchema.shape.entities.element.shape.entityType;
    // a (catch-wrapped) ZodEnum exposes .options via the helper; ZodString does not
    expect(Array.isArray(enumOptions(entityType))).toBe(true);
    expect(enumOptions(entityType)).toEqual(
      expect.arrayContaining(["function", "other"])
    );
  });

  it("scopes relationType to the domain's predicates when a content class is detected (KG-05)", async () => {
    let capturedSchema: any;
    const promptManager = {
      getUserPrompt: async () => "u",
      getSystemPrompt: async () => "s",
    } as any;
    const llmService = {
      generateStructured: async (_m: any, schema: any) => {
        capturedSchema = schema;
        return { entities: [], relations: [] };
      },
      getModelCapabilities: async () => [],
    } as any;
    const builder = new KnowledgeGraphBuilder(
      { llmService, promptManager, model: "m" },
      stubLogger()
    );

    const processedFile = {
      path: "chart.txt",
      content: "x",
      metadata: { classes: [{ class: "medical", confidence: 0.9 }] },
      chunks: [{ content: "c", index: 1, totalChunks: 1, startOffset: 0, endOffset: 1 }],
    } as any;

    await builder.build(processedFile, "s");

    // Pre-Phase-2 the relation enum excluded the domain predicates the hints and
    // gold examples teach, so an emitted `treats`/`diagnosed_with` failed Zod
    // validation → empty graph. They must now be in the enum.
    // relationType is wrapped in z.preprocess (scalar→array coercion); unwrap to the array.
    const relationType = capturedSchema.shape.relations.element.shape.relationType._def.schema;
    expect(enumOptions(relationType.element)).toEqual(
      expect.arrayContaining(["treats", "diagnosed_with", "related_to"])
    );
  });

  it("unions corpus-glossary entity types into the enum and injects the glossary", async () => {
    let capturedSchema: any;
    const capturedCtx: any[] = [];
    const promptManager = {
      getUserPrompt: async (ctx: any) => {
        capturedCtx.push(ctx);
        return "u";
      },
      getSystemPrompt: async () => "s",
    } as any;
    const llmService = {
      generateStructured: async (_m: any, schema: any) => {
        capturedSchema = schema;
        return { entities: [], relations: [] };
      },
      getModelCapabilities: async () => [],
    } as any;
    const builder = new KnowledgeGraphBuilder(
      { llmService, promptManager, model: "m" },
      stubLogger()
    );

    const processedFile = {
      path: "f.txt",
      content: "x",
      chunks: [{ content: "c", index: 1, totalChunks: 1, startOffset: 0, endOffset: 1 }],
    } as any;
    const glossary = {
      entityNames: ["Bayes Theorem"],
      entityTypes: ["theorem"],
      relationTypes: ["assumes"],
    };

    await builder.build(processedFile, "s", undefined, glossary);

    // glossary forwarded to the prompt context
    expect(capturedCtx[0].corpusGlossary).toEqual(glossary);
    // entityType enum exists (no class detected, glossary alone drives it) and
    // includes the glossary type + the "other" escape
    const entityType = capturedSchema.shape.entities.element.shape.entityType;
    expect(enumOptions(entityType)).toEqual(
      expect.arrayContaining(["theorem", "other"])
    );
    // relationType is now a closed enum unioning glossary predicates + base set +
    // the "related_to" catch-all
    // relationType is wrapped in z.preprocess (scalar→array coercion); unwrap to the array.
    const relationType = capturedSchema.shape.relations.element.shape.relationType._def.schema;
    expect(enumOptions(relationType.element)).toEqual(
      expect.arrayContaining(["assumes", "uses", "related_to"])
    );
  });

  it("closes the relationType enum to the base set even with no class or glossary", async () => {
    let capturedSchema: any;
    const llmService = {
      generateStructured: async (_m: any, schema: any) => {
        capturedSchema = schema;
        return { entities: [], relations: [] };
      },
      getModelCapabilities: async () => [],
    } as any;
    const builder = new KnowledgeGraphBuilder(
      {
        llmService,
        promptManager: { getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any,
        model: "m",
      },
      stubLogger()
    );

    const processedFile = {
      path: "f.txt",
      content: "x",
      chunks: [{ content: "c", index: 1, totalChunks: 1, startOffset: 0, endOffset: 1 }],
    } as any;

    await builder.build(processedFile, "s");

    const entityType = capturedSchema.shape.entities.element.shape.entityType;
    // relationType is wrapped in z.preprocess (scalar→array coercion); unwrap to the array.
    const relationType = capturedSchema.shape.relations.element.shape.relationType._def.schema;
    expect(enumOptions(entityType)).toEqual(expect.arrayContaining(["function", "other"]));
    expect(enumOptions(relationType.element)).toEqual(
      expect.arrayContaining(["depends_on", "related_to"])
    );
  });

  const SOURCE =
    "Recursion is when a function calls itself repeatedly until a base case.";
  const hallucinatingLlm = () =>
    ({
      generateStructured: async () => ({
        entities: [
          {
            name: "Recursion",
            entityType: "concept",
            observations: [
              "Recursion is when a function calls itself", // grounded in SOURCE
              "Recursion was invented in the year 1742 by Zorblax", // fabricated
            ],
          },
        ],
        relations: [],
      }),
      getModelCapabilities: async () => [],
    } as any);

  const groundingFile = () =>
    ({
      path: "f.txt",
      content: SOURCE,
      chunks: [{ content: SOURCE, index: 1, totalChunks: 1, startOffset: 0, endOffset: SOURCE.length }],
    } as any);

  it("grounding gate (drop) removes an observation absent from the source", async () => {
    const builder = new KnowledgeGraphBuilder(
      {
        llmService: hallucinatingLlm(),
        promptManager: { getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any,
        model: "m",
        grounding: "drop",
        groundingMinScore: 0.5,
      },
      stubLogger()
    );
    const [kg] = await builder.build(groundingFile(), "s");
    const texts = kg.entities[0].observations.map((o) => o.text);
    expect(texts).toContain("Recursion is when a function calls itself");
    expect(texts.some((t) => t.includes("1742"))).toBe(false); // hallucination dropped
  });

  it("grounding gate (flag) annotates without dropping", async () => {
    const builder = new KnowledgeGraphBuilder(
      {
        llmService: hallucinatingLlm(),
        promptManager: { getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any,
        model: "m",
        grounding: "flag",
        groundingMinScore: 0.5,
      },
      stubLogger()
    );
    const [kg] = await builder.build(groundingFile(), "s");
    const obs = kg.entities[0].observations;
    expect(obs).toHaveLength(2); // nothing dropped
    const grounded = obs.find((o) => o.text.includes("calls itself"))!;
    const fabricated = obs.find((o) => o.text.includes("1742"))!;
    expect(grounded.grounded).toBe(true);
    expect(fabricated.grounded).toBe(false);
  });

  const relationLlm = () =>
    ({
      generateStructured: async () => ({
        entities: [],
        relations: [
          { from: "function", to: "itself", relationType: ["calls"] }, // grounded
          { from: "Zorblax", to: "Recursion", relationType: ["invented"] }, // fabricated
        ],
      }),
      getModelCapabilities: async () => [],
    } as any);

  it("grounding gate (drop) removes a relation triple absent from the source", async () => {
    const builder = new KnowledgeGraphBuilder(
      {
        llmService: relationLlm(),
        promptManager: { getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any,
        model: "m",
        grounding: "drop",
        groundingMinScore: 0.5,
      },
      stubLogger()
    );
    const [kg] = await builder.build(groundingFile(), "s");
    expect(kg.relations.map((r) => r.from)).toEqual(["function"]); // Zorblax edge dropped
  });

  it("records grounding rejections for the run manifest (WI3 trace)", async () => {
    const builder = new KnowledgeGraphBuilder(
      {
        llmService: relationLlm(),
        promptManager: { getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any,
        model: "m",
        grounding: "drop",
        groundingMinScore: 0.5,
      },
      stubLogger()
    );
    await builder.build(groundingFile(), "s");
    const rej = builder.getGroundingRejections();
    expect(rej).toHaveLength(1);
    expect(rej[0]).toMatchObject({ kind: "relation", subject: "Zorblax→Recursion", dropped: true });
  });

  // KG-02: a failed extraction must be recorded and left uncheckpointed, not
  // swallowed into an empty graph and cached as done.
  const throwingLlm = () =>
    ({
      generateStructured: async () => {
        throw new Error("boom: retries exhausted");
      },
      getModelCapabilities: async () => [],
    } as any);
  const promptStub = () =>
    ({ getUserPrompt: async () => "u", getSystemPrompt: async () => "s" } as any);
  const oneChunkFile = () =>
    ({
      path: "f.txt",
      content: "x",
      chunks: [{ content: "c", index: 1, totalChunks: 1, startOffset: 0, endOffset: 1 }],
    } as any);

  it("records a failed chunk instead of swallowing the error", async () => {
    const builder = new KnowledgeGraphBuilder(
      { llmService: throwingLlm(), promptManager: promptStub(), model: "m" },
      stubLogger()
    );
    const [kg] = await builder.build(oneChunkFile(), "s");
    expect(kg.entities).toEqual([]);
    const failed = builder.getFailedChunks();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ filePath: "f.txt", chunkIndex: 1, totalChunks: 1 });
    expect(failed[0].error).toContain("boom");
  });

  it("leaves a failed chunk uncheckpointed so --resume retries it", async () => {
    const appended: any[] = [];
    const checkpoint = {
      computeKey: () => "key1",
      has: () => false,
      get: () => undefined,
      append: async (rec: any) => {
        appended.push(rec);
      },
    } as any;
    const builder = new KnowledgeGraphBuilder(
      {
        llmService: throwingLlm(),
        promptManager: promptStub(),
        model: "m",
        resume: true,
        checkpoint,
      },
      stubLogger()
    );
    await builder.build(oneChunkFile(), "s");
    expect(appended).toHaveLength(0); // failure never written to the checkpoint
    expect(builder.getFailedChunks()).toHaveLength(1);
  });

  // KG-07: the checkpoint key must fold in everything that changes extraction
  // semantics (glossary, classifier classes, grounding, system prompt, retrieval),
  // so toggling any of them between --resume runs re-extracts instead of reusing a
  // graph built under different settings.
  it("checkpoint key (extra) is sensitive to glossary and grounding", async () => {
    const extras: string[] = [];
    const checkpoint = {
      computeKey: (...args: any[]) => {
        extras.push(String(args[5])); // the extractionExtra signature
        return args.join("|");
      },
      has: () => false,
      get: () => undefined,
      append: async () => {},
    } as any;
    const build = async (opts: any, systemPrompt: string, glossary?: any, retrieve?: any) => {
      const builder = new KnowledgeGraphBuilder(
        { llmService: hallucinatingLlm(), promptManager: promptStub(), model: "m", resume: true, checkpoint, ...opts },
        stubLogger()
      );
      await builder.build(oneChunkFile(), systemPrompt, retrieve, glossary);
    };

    await build({}, "sysA"); // [0] baseline
    await build({}, "sysA"); // [1] identical → same extra
    await build({}, "sysA", { entityNames: ["X"], entityTypes: [], relationTypes: [] }); // [2] glossary differs
    await build({ groundingSignature: "drop|minicheck|0.5" }, "sysA"); // [3] grounding differs
    await build({}, "sysB"); // [4] system prompt (schema/vocab) differs
    await build({}, "sysA", undefined, async () => ["retrieved ctx A"]); // [5] retrieval on, context A
    await build({}, "sysA", undefined, async () => ["totally different ctx B"]); // [6] retrieval on, context B

    expect(extras[1]).toBe(extras[0]); // identical inputs → identical key
    expect(extras[2]).not.toBe(extras[0]); // glossary change re-keys
    expect(extras[3]).not.toBe(extras[0]); // grounding change re-keys
    expect(extras[4]).not.toBe(extras[0]); // system-prompt/schema change re-keys
    // Retrieved context is a non-deterministic OUTPUT of prior extractions, not a
    // config input: it must NOT re-key, or --resume re-extracts everything when
    // retrieval is on (the default). Differing context, same key as the baseline.
    expect(extras[5]).toBe(extras[0]);
    expect(extras[6]).toBe(extras[5]);
  });
});
