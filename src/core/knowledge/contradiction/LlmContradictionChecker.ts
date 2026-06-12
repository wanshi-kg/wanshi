import { z } from "zod";
import { Logger } from "../../../shared";
import { ILLMProvider, IContradictionChecker, ContradictionVerdict } from "../../../types";
import { HeuristicContradictionChecker } from "./HeuristicContradictionChecker";

const Schema = z.object({
  contradicts: z.boolean().describe("true iff the two statements cannot both be true"),
});

/**
 * LLM-backed contradiction detector (KG-10), the Graphiti-style check: asks the
 * generation model whether two facts about one entity contradict. Falls back to
 * the heuristic when the call errors, so a flaky model never crashes the merge.
 */
export class LlmContradictionChecker implements IContradictionChecker {
  private readonly fallback = new HeuristicContradictionChecker();

  constructor(
    private readonly llm: ILLMProvider,
    private readonly logger: Logger
  ) {}

  async check(a: string, b: string): Promise<ContradictionVerdict> {
    try {
      const res = await this.llm.generateStructured(
        [
          {
            role: "system",
            content:
              "You decide whether two statements about the SAME entity contradict — " +
              "i.e. they cannot both be true at the same time. Differences in detail or " +
              "elaboration are NOT contradictions. Respond only with the JSON schema.",
          },
          { role: "user", content: `Statement A: ${a}\nStatement B: ${b}` },
        ],
        Schema,
        2
      );
      return { contradicts: !!res.contradicts, checker: "llm" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `LLM contradiction check failed (${message}); falling back to heuristic`
      );
      return this.fallback.check(a, b);
    }
  }
}
