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
});
