import * as fs from "fs";
import * as path from "path";
import { Logger, shutdown } from "../../shared";
import { LLMUsage } from "../../types/ILLMProvider";
import { DEFAULT_PRICES, ModelPrice, PRICES_AS_OF } from "./prices";

/** Rough pre-run estimate constants (deliberately approximate; the end tally is exact). */
export const CHARS_PER_TOKEN = 4;
export const SYSTEM_OVERHEAD_TOKENS = 900; // v5 system prompt + retrieved context, per chunk
export const OUTPUT_TOKENS_PER_CHUNK = 400; // a chunk's worth of entities/relations JSON

/**
 * Conservative fallback USD/1M-token price used ONLY when a `--max-cost` cap is
 * set on an UNPRICED model (WS-13). Without it the cap could never trip — an
 * unpriced id keeps cost at 0 forever, turning a budget ceiling into unlimited
 * spend. This is a deliberately pessimistic floor (≈ a mid cloud model) so the
 * cap stays *actionable*; the user is warned that the figure is a cap-only
 * estimate, not a real bill, and should set `cost.prices` for accuracy. With no
 * `--max-cost`, the default path is untouched (unpriced ⇒ still shown as $0).
 */
export const UNPRICED_CAP_FALLBACK: ModelPrice = { in: 5, out: 15 };

export interface CostBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}
const emptyBucket = (): CostBucket => ({ calls: 0, promptTokens: 0, completionTokens: 0, cost: 0 });

/** The cumulative ledger persisted across resume runs (`<output>.cost.json`). */
export interface CostLedger {
  currency: string;
  runs: number;
  updatedAt: string;
  total: CostBucket;
  perModel: Record<string, CostBucket>;
}

export interface CostEstimate {
  estChunks: number;
  estPromptTokens: number;
  estCompletionTokens: number;
  estCost: number;
  priced: boolean;
}

export interface CostMeterConfig {
  enabled: boolean;
  maxCost?: number;
  currency: string;
  prices: Record<string, ModelPrice>;
  ledgerPath?: string;
  logger?: Logger;
}

/**
 * Cost / token meter — a module singleton (à la `shared/shutdown` and the trace
 * writer) so every LLM provider can `meter.record(...)` without DI plumbing.
 * `ContainerFactory` calls `configure` once. Off by default ⇒ `record` is an early
 * return guarded at the call site by `if (meter.enabled)`, so a default run carries
 * zero overhead and is byte-identical.
 *
 * Accounting is split: `thisRun` is what the current invocation spent (drives the
 * `--max-cost` cap + this-run tally); `prior` is the cumulative loaded from the
 * ledger. Resumed chunks skip generation entirely (no `record`), so re-running a
 * finished job adds $0 — the ledger never double-counts.
 */
export class CostMeter {
  private _enabled = false;
  private maxCost?: number;
  private currency = "USD";
  private prices: Record<string, ModelPrice> = {};
  private ledgerPath?: string;
  private logger?: Logger;

  private thisRunTotal = emptyBucket();
  private thisRunByModel = new Map<string, CostBucket>();
  private prior?: CostLedger;
  private capTripped = false;
  private readonly warnedModels = new Set<string>();

  get enabled(): boolean {
    return this._enabled;
  }
  get thisRunCost(): number {
    return this.thisRunTotal.cost;
  }

  /** Attach the resolved run logger (ContainerFactory configures the meter before one exists). */
  attachLogger(logger: Logger): void {
    this.logger = logger;
  }

  configure(config: CostMeterConfig): void {
    this._enabled = config.enabled;
    this.maxCost = config.maxCost;
    this.currency = config.currency || "USD";
    this.prices = { ...DEFAULT_PRICES, ...(config.prices || {}) };
    this.ledgerPath = config.ledgerPath;
    this.logger = config.logger;
    this.thisRunTotal = emptyBucket();
    this.thisRunByModel = new Map();
    this.capTripped = false;
    this.warnedModels.clear();
    this.prior = this._enabled ? this.loadLedger() : undefined;
  }

  /** USD per 1M {in,out} tokens for a model: exact id, then the longest substring key, else 0. */
  priceFor(model: string): ModelPrice {
    if (this.prices[model]) return this.prices[model];
    let best: { key: string; price: ModelPrice } | undefined;
    for (const [key, price] of Object.entries(this.prices)) {
      if (model.includes(key) && (!best || key.length > best.key.length)) best = { key, price };
    }
    return best?.price ?? { in: 0, out: 0 };
  }

  /** Record one generation's usage. Guarded by `enabled` at the call site, but safe regardless. */
  record(model: string, usage?: LLMUsage): void {
    if (!this._enabled || !usage) return;
    let price = this.priceFor(model);
    const unpriced = price.in === 0 && price.out === 0;
    if (unpriced && this.maxCost != null) {
      // WS-13: an unpriced model under a --max-cost cap would keep cost at 0 and
      // the cap could never trip — silent unlimited spend. Fall back to a
      // conservative price floor so the cap stays actionable, and ESCALATE the
      // note to a warning.
      price = UNPRICED_CAP_FALLBACK;
      if (!this.warnedModels.has(model)) {
        this.warnedModels.add(model);
        this.logger?.warn(
          `Cost meter: no price for model '${model}' but --max-cost is set — billing it at a conservative ` +
            `fallback rate (${this.currency} ${price.in}/${price.out} per 1M in/out tokens) so the cap can act. ` +
            `Set cost.prices['${model}'] for an accurate cap and bill.`
        );
      }
    } else if (unpriced && !this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      this.logger?.info(`Cost meter: no price for model '${model}' — its spend is shown as ${this.currency} 0 (set cost.prices for an accurate bill).`);
    }
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const cost = (prompt / 1e6) * price.in + (completion / 1e6) * price.out;

    const bucket = this.thisRunByModel.get(model) ?? emptyBucket();
    bucket.calls++;
    bucket.promptTokens += prompt;
    bucket.completionTokens += completion;
    bucket.cost += cost;
    this.thisRunByModel.set(model, bucket);

    this.thisRunTotal.calls++;
    this.thisRunTotal.promptTokens += prompt;
    this.thisRunTotal.completionTokens += completion;
    this.thisRunTotal.cost += cost;

    if (this.maxCost != null && this.thisRunTotal.cost > this.maxCost && !this.capTripped) {
      this.capTripped = true;
      this.logger?.warn(
        `Cost cap reached: spent ${this.fmt(this.thisRunTotal.cost)} > cap ${this.fmt(this.maxCost)} this run. ` +
          `Finishing the in-flight chunk, checkpointing, and exporting the partial graph — re-run with --resume to continue.`
      );
      shutdown.request();
    }
  }

  /** Rough pre-run projection from total input characters + chunk size. */
  estimate(totalInputChars: number, chunkSize: number, model: string): CostEstimate {
    const estChunks = chunkSize > 0 ? Math.ceil(totalInputChars / chunkSize) : 0;
    const estPromptTokens = estChunks * (Math.ceil(chunkSize / CHARS_PER_TOKEN) + SYSTEM_OVERHEAD_TOKENS);
    const estCompletionTokens = estChunks * OUTPUT_TOKENS_PER_CHUNK;
    const price = this.priceFor(model);
    const estCost = (estPromptTokens / 1e6) * price.in + (estCompletionTokens / 1e6) * price.out;
    return { estChunks, estPromptTokens, estCompletionTokens, estCost, priced: price.in > 0 || price.out > 0 };
  }

  /** Multi-line human summary for the end-of-run log (this run + cumulative). */
  summary(): string {
    const lines: string[] = ["Cost / token usage (this run):"];
    if (this.thisRunByModel.size === 0) {
      lines.push("  (no metered LLM calls)");
    } else {
      for (const [model, b] of this.thisRunByModel) {
        lines.push(`  ${model}: ${b.calls} call(s), ${b.promptTokens}+${b.completionTokens} tok, ${this.fmt(b.cost)}`);
      }
    }
    lines.push(`  TOTAL this run: ${this.thisRunTotal.promptTokens + this.thisRunTotal.completionTokens} tok, ${this.fmt(this.thisRunTotal.cost)}`);
    const cum = this.cumulative();
    if (this.prior) {
      lines.push(`  CUMULATIVE (incl. prior resume runs): ${this.fmt(cum.total.cost)} over ${cum.runs} run(s)`);
    }
    lines.push(`  (prices best-effort as of ${PRICES_AS_OF}; override via cost.prices)`);
    return lines.join("\n");
  }

  /** Persist the cumulative ledger (prior + this run). No-op without a path. */
  persistLedger(): void {
    if (!this._enabled || !this.ledgerPath) return;
    const ledger = this.cumulative();
    try {
      fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
      fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    } catch {
      /* best-effort side channel — never fail the run over the ledger */
    }
  }

  /** prior + this-run, folded into a fresh ledger object. */
  private cumulative(): CostLedger {
    const total = emptyBucket();
    const perModel: Record<string, CostBucket> = {};
    const add = (into: CostBucket, b: CostBucket) => {
      into.calls += b.calls;
      into.promptTokens += b.promptTokens;
      into.completionTokens += b.completionTokens;
      into.cost += b.cost;
    };
    if (this.prior) {
      add(total, this.prior.total);
      for (const [m, b] of Object.entries(this.prior.perModel)) {
        perModel[m] = emptyBucket();
        add(perModel[m], b);
      }
    }
    add(total, this.thisRunTotal);
    for (const [m, b] of this.thisRunByModel) {
      perModel[m] = perModel[m] ?? emptyBucket();
      add(perModel[m], b);
    }
    return {
      currency: this.currency,
      runs: (this.prior?.runs ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      total,
      perModel,
    };
  }

  private loadLedger(): CostLedger | undefined {
    if (!this.ledgerPath || !fs.existsSync(this.ledgerPath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(this.ledgerPath, "utf-8")) as CostLedger;
    } catch {
      return undefined; // corrupt ledger — start cumulative fresh rather than crash
    }
  }

  private fmt(n: number): string {
    return `${this.currency} ${n.toFixed(n < 1 ? 4 : 2)}`;
  }

  /** Test hook — restore the disabled default. */
  reset(): void {
    this._enabled = false;
    this.maxCost = undefined;
    this.prices = {};
    this.ledgerPath = undefined;
    this.logger = undefined;
    this.thisRunTotal = emptyBucket();
    this.thisRunByModel = new Map();
    this.prior = undefined;
    this.capTripped = false;
    this.warnedModels.clear();
  }
}

/** The process-wide cost meter singleton. */
export const meter = new CostMeter();
