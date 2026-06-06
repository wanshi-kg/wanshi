import { KnowledgeGraphBuilder } from "./KnowledgeGraphBuilder";
import { stubLogger } from "../../__tests__/helpers";

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
    // a ZodEnum exposes .options; ZodString does not
    expect(Array.isArray(entityType.options)).toBe(true);
    expect(entityType.options).toEqual(
      expect.arrayContaining(["function", "other"])
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
    expect(entityType.options).toEqual(
      expect.arrayContaining(["theorem", "other"])
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
});
