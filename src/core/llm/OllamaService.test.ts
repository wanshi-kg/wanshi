import { z } from "zod";
import { OllamaService } from "./OllamaService";
import { stubLogger } from "../../__tests__/helpers";

/**
 * Guards KG-03: temperature / repeat_penalty / seed were commented out of the
 * Ollama request, so the documented sampling/determinism knobs silently no-op'd
 * and local runs extracted at Ollama's own defaults. Assert they reach the
 * request now (and that optional ones are omitted when unset).
 */
describe("OllamaService request construction (KG-03)", () => {
  const schema = z.object({ ok: z.boolean() });

  function makeService(opts: Record<string, unknown>) {
    const calls: any[] = [];
    const service = new OllamaService({ model: "m", ...opts } as any, stubLogger());
    // Replace the real client so we can capture the constructed request.
    (service as any).ollama = {
      chat: async (req: any) => {
        calls.push(req);
        return {
          message: { content: '{"ok":true}' },
          done_reason: "stop",
          eval_count: 1,
          prompt_eval_count: 1,
          total_duration: 1_000_000,
        };
      },
      show: async () => ({ capabilities: [] }),
    };
    return { service, calls };
  }

  it("passes temperature, repeat_penalty, num_ctx, num_predict and seed when set", async () => {
    const { service, calls } = makeService({
      temperature: 0.1,
      repeatPenalty: 1.1,
      contextLength: 4096,
      seed: 7,
      maxTokens: 256,
    });

    await service.generateStructured([{ role: "user", content: "hi" }], schema);

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({
      num_ctx: 4096,
      num_predict: 256,
      temperature: 0.1,
      repeat_penalty: 1.1,
      seed: 7,
    });
  });

  it("omits seed and num_predict when unset", async () => {
    const { service, calls } = makeService({
      temperature: 0.2,
      repeatPenalty: 1.0,
      contextLength: 8192,
    });

    await service.generateStructured([{ role: "user", content: "hi" }], schema);

    const options = calls[0].options;
    expect(options.temperature).toBe(0.2);
    expect(options.repeat_penalty).toBe(1.0);
    expect("seed" in options).toBe(false);
    expect("num_predict" in options).toBe(false);
  });
});
