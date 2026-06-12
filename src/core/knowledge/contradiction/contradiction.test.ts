import { HeuristicContradictionChecker } from "./HeuristicContradictionChecker";
import { LlmContradictionChecker } from "./LlmContradictionChecker";
import { stubLogger } from "../../../__tests__/helpers";

describe("HeuristicContradictionChecker", () => {
  const c = new HeuristicContradictionChecker();

  it("flags opposite antonyms over a shared topic", async () => {
    expect((await c.check("the cache is enabled", "the cache is disabled")).contradicts).toBe(true);
    expect((await c.check("Alice joined TechCorp", "Alice left TechCorp")).contradicts).toBe(true);
  });

  it("does NOT flag antonyms about different topics", async () => {
    // enabled/disabled but no shared content word → different subjects
    expect((await c.check("logging is enabled", "telemetry is disabled")).contradicts).toBe(false);
  });

  it("flags a negated near-duplicate", async () => {
    expect(
      (await c.check("the service uploads your data", "the service does not upload your data")).contradicts
    ).toBe(true);
  });

  it("does not flag elaboration / unrelated facts", async () => {
    expect((await c.check("recursion calls itself", "recursion needs a base case")).contradicts).toBe(false);
    expect((await c.check("the sky is blue", "grass is green")).contradicts).toBe(false);
  });
});

describe("LlmContradictionChecker", () => {
  it("uses the LLM verdict", async () => {
    const llm = { generateStructured: async () => ({ contradicts: true }), getModelCapabilities: async () => [] } as any;
    const v = await new LlmContradictionChecker(llm, stubLogger()).check("a", "b");
    expect(v).toEqual({ contradicts: true, checker: "llm" });
  });

  it("falls back to the heuristic when the LLM throws", async () => {
    const llm = { generateStructured: async () => { throw new Error("down"); }, getModelCapabilities: async () => [] } as any;
    const v = await new LlmContradictionChecker(llm, stubLogger()).check(
      "the cache is enabled",
      "the cache is disabled"
    );
    expect(v.contradicts).toBe(true);
    expect(v.checker).toBe("heuristic"); // fallback
  });
});
