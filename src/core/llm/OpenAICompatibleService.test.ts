import { z } from "zod";
import { OpenAICompatibleService } from "./OpenAICompatibleService";
import { stubLogger } from "../../__tests__/helpers";
import { meter } from "../cost";

/**
 * Guards WS-60: some OpenAI-compatible endpoints omit the `usage` block on a
 * completion. Previously logUsage() was a no-op in that case, so meter.record
 * was never called and the call was silently unmetered ($0). The fix estimates
 * completion tokens from the response length and still records.
 */
describe("OpenAICompatibleService usage metering (WS-60)", () => {
  const schema = z.object({ ok: z.boolean() });
  const MODEL = "test-cloud-model";
  const PRICES = { [MODEL]: { in: 10, out: 30 } }; // USD per 1M tokens

  afterEach(() => {
    meter.reset();
  });

  function makeService() {
    const service = new OpenAICompatibleService(
      { model: MODEL } as any,
      stubLogger()
    );
    return service;
  }

  /** Replace the real OpenAI client with a stub returning the given completion. */
  function stubClient(service: OpenAICompatibleService, completion: any) {
    (service as any).client = {
      chat: { completions: { create: async () => completion } },
    };
  }

  it("estimates tokens and records when the completion has NO usage block", async () => {
    const content = '{"ok":true}'; // 11 chars → ceil(11/4) = 3 tokens
    const service = makeService();
    stubClient(service, {
      choices: [{ message: { content }, finish_reason: "stop" }],
      // no `usage` field
    });

    meter.configure({ enabled: true, currency: "USD", prices: PRICES });

    const result = await service.generateStructured(
      [{ role: "user", content: "hi" }],
      schema
    );
    expect(result).toEqual({ ok: true });

    // lastUsage is set to an estimate (not undefined) so the trace/cost seam works
    const usage = service.getLastUsage();
    expect(usage).toBeDefined();
    expect(usage!.completionTokens).toBe(Math.ceil(content.length / 4));

    // meter actually recorded the call (non-zero cost from the estimated tokens)
    expect(meter.thisRunCost).toBeGreaterThan(0);
    expect(meter.summary()).toMatch(/1 call\(s\)/);
  });

  it("uses the real usage block when the completion provides one", async () => {
    const service = makeService();
    stubClient(service, {
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    meter.configure({ enabled: true, currency: "USD", prices: PRICES });

    await service.generateStructured([{ role: "user", content: "hi" }], schema);

    const usage = service.getLastUsage();
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    // cost = (100/1e6 * 10) + (50/1e6 * 30) = 0.001 + 0.0015 = 0.0025
    expect(meter.thisRunCost).toBeCloseTo(0.0025, 6);
  });
});
