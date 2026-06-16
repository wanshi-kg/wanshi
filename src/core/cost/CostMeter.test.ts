import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { meter } from "./CostMeter";
import { shutdown } from "../../shared";

const M = "test-model";
const PRICES = { [M]: { in: 10, out: 30 } }; // USD per 1M tokens

afterEach(() => {
  meter.reset();
  shutdown.reset();
});

describe("CostMeter", () => {
  it("is a no-op when disabled (zero overhead / byte-identical default run)", () => {
    meter.configure({ enabled: false, currency: "USD", prices: PRICES });
    meter.record(M, { promptTokens: 1000, completionTokens: 1000 });
    expect(meter.enabled).toBe(false);
    expect(meter.thisRunCost).toBe(0);
  });

  it("accumulates per-model tokens and cost via the price map", () => {
    meter.configure({ enabled: true, currency: "USD", prices: PRICES });
    meter.record(M, { promptTokens: 1_000_000, completionTokens: 1_000_000 }); // 1M in + 1M out
    meter.record(M, { promptTokens: 500_000, completionTokens: 0 });
    // cost = (1.0*10 + 1.0*30) + (0.5*10) = 45
    expect(meter.thisRunCost).toBeCloseTo(45, 6);
    expect(meter.summary()).toMatch(/2 call\(s\)/);
  });

  it("priceFor: exact, longest-substring, and unknown→0", () => {
    meter.configure({ enabled: true, currency: "USD", prices: PRICES }); // + built-in DEFAULT_PRICES
    expect(meter.priceFor(M)).toEqual({ in: 10, out: 30 });
    // built-in 'gpt-4o' matches a dated id by substring
    expect(meter.priceFor("gpt-4o-2024-08-06").out).toBeGreaterThan(0);
    // 'gpt-4o-mini' is a longer key than 'gpt-4o' → wins for the mini id
    expect(meter.priceFor("openai/gpt-4o-mini")).toEqual(meter.priceFor("gpt-4o-mini"));
    expect(meter.priceFor("some-local-model:7b")).toEqual({ in: 0, out: 0 });
  });

  it("trips the --max-cost cap via shutdown.request() (graceful stop)", () => {
    meter.configure({ enabled: true, maxCost: 0.02, currency: "USD", prices: PRICES });
    expect(shutdown.isRequested()).toBe(false);
    meter.record(M, { promptTokens: 1000, completionTokens: 1000 }); // (0.001*10 + 0.001*30) = 0.04 > 0.02
    expect(shutdown.isRequested()).toBe(true);
  });

  it("estimate(): chunk count from chars/chunkSize, priced when the model has a price", () => {
    meter.configure({ enabled: true, currency: "USD", prices: PRICES });
    const est = meter.estimate(10_000, 2_000, M);
    expect(est.estChunks).toBe(5);
    expect(est.priced).toBe(true);
    expect(est.estCost).toBeGreaterThan(0);
    const free = meter.estimate(10_000, 2_000, "unknown-local:7b");
    expect(free.priced).toBe(false);
    expect(free.estCost).toBe(0);
  });

  it("ledger: persists cumulative and does NOT double-count a no-spend resume", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "costledger-"));
    const ledgerPath = path.join(dir, "out.cost.json");

    // run 1: real spend
    meter.configure({ enabled: true, currency: "USD", prices: PRICES, ledgerPath });
    meter.record(M, { promptTokens: 1_000_000, completionTokens: 0 }); // $10
    meter.persistLedger();
    const after1 = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    expect(after1.total.cost).toBeCloseTo(10, 6);
    expect(after1.runs).toBe(1);

    // run 2: resume with everything cached → no record() calls → cumulative unchanged
    meter.configure({ enabled: true, currency: "USD", prices: PRICES, ledgerPath });
    expect(meter.thisRunCost).toBe(0);
    meter.persistLedger();
    const after2 = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    expect(after2.total.cost).toBeCloseTo(10, 6); // NOT 20
    expect(after2.runs).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
