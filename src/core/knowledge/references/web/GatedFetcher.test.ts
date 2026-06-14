import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GatedFetcher, GatedFetcherOptions } from "./GatedFetcher";
import { stubLogger } from "../../../../__tests__/helpers";

const stubLlm = (relevant = true) =>
  ({
    generateStructured: async () => ({ relevant }),
    getModelCapabilities: async () => [],
  } as any);

const baseOpts = (over: Partial<GatedFetcherOptions> = {}): GatedFetcherOptions => ({
  allowlist: ["example.com"],
  rejectlist: [],
  maxFetches: 50,
  timeoutMs: 1000,
  maxBytes: 1_000_000,
  relevanceCheck: false,
  robots: false,
  ...over,
});

const html = (title: string) => `<html><head><title>${title}</title></head><body>hi</body></html>`;
const resp = (body: string, ct = "text/html", status = 200) =>
  new Response(body, { status, headers: { "content-type": ct } });

describe("GatedFetcher", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kggf-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const make = (opts: GatedFetcherOptions, fetchFn: any, llm = stubLlm()) =>
    new GatedFetcher(opts, llm, stubLogger(), tmp, fetchFn);

  it("does NOT touch the network for an off-allowlist URL", async () => {
    const fetchFn = jest.fn();
    const r = await make(baseOpts(), fetchFn).fetch("https://evil.com/x", "scope");
    expect(r).toMatchObject({ resolved: false, reason: "not-allowlisted" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches an allowlisted html page and stages a temp file", async () => {
    const fetchFn = jest.fn(async () => resp(html("Hello")));
    const r = await make(baseOpts(), fetchFn).fetch("https://example.com/p", "scope");
    expect(r.resolved).toBe(true);
    expect(r.title).toBe("Hello");
    expect(fs.existsSync(r.tempPath!)).toBe(true);
  });

  it("rejects non-html content types without staging", async () => {
    const fetchFn = jest.fn(async () => resp("%PDF...", "application/pdf"));
    const r = await make(baseOpts(), fetchFn).fetch("https://example.com/f.pdf", "scope");
    expect(r).toMatchObject({ resolved: false });
    expect(r.reason).toMatch(/content-type/);
  });

  it("rejects oversize bodies", async () => {
    const fetchFn = jest.fn(async () => resp(html("x".repeat(5000))));
    const r = await make(baseOpts({ maxBytes: 100 }), fetchFn).fetch("https://example.com/p", "scope");
    expect(r).toMatchObject({ resolved: false, reason: "too-large" });
  });

  it("maps an aborted fetch to a timeout reason", async () => {
    const fetchFn = jest.fn(async () => {
      const e: any = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const r = await make(baseOpts(), fetchFn).fetch("https://example.com/p", "scope");
    expect(r).toMatchObject({ resolved: false, reason: "timeout" });
  });

  it("enforces the per-run fetch budget", async () => {
    const fetchFn = jest.fn(async () => resp(html("ok")));
    const f = make(baseOpts({ maxFetches: 1 }), fetchFn);
    expect((await f.fetch("https://example.com/a", "s")).resolved).toBe(true);
    const second = await f.fetch("https://example.com/b", "s");
    expect(second).toMatchObject({ resolved: false, reason: "budget-exceeded" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("skips when the relevance gate says no", async () => {
    const fetchFn = jest.fn(async () => resp(html("Off topic")));
    const r = await make(baseOpts({ relevanceCheck: true }), fetchFn, stubLlm(false)).fetch(
      "https://example.com/p",
      "ML papers"
    );
    expect(r).toMatchObject({ resolved: false, reason: "irrelevant" });
  });

  it("honors robots.txt Disallow", async () => {
    const fetchFn = jest.fn(async (url: string) =>
      url.endsWith("/robots.txt")
        ? resp("User-agent: *\nDisallow: /private", "text/plain")
        : resp(html("secret"))
    );
    const r = await make(baseOpts({ robots: true }), fetchFn).fetch(
      "https://example.com/private/x",
      "s"
    );
    expect(r).toMatchObject({ resolved: false, reason: "robots-disallow" });
  });
});
