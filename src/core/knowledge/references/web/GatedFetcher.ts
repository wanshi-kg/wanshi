import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";
import { ILLMProvider } from "../../../../types/ILLMProvider";
import { Logger } from "../../../../shared";

/**
 * The shared Phase-1 network primitive: fetch one external URL behind layered,
 * always-on guards. Returns a staged temp file only when EVERY guard passes;
 * any failure yields `{ resolved:false, reason }` (never fabricated content).
 *
 * Guard order (cheapest/safest first): allowlist (empty ⇒ no fetch, the master
 * switch) → rejectlist → robots.txt → per-run budget → timed fetch → content-type
 * → size cap → LLM relevance pre-check. Offline-first: this only runs when the
 * caller opted into `references.web`; a default run never constructs it.
 */
const USER_AGENT = "wanshi-reference-fetcher/1 (+https://github.com/AlexSabaka/wanshi)";

export interface GatedFetcherOptions {
  allowlist: string[];
  rejectlist: string[];
  maxFetches: number;
  timeoutMs: number;
  maxBytes: number;
  relevanceCheck: boolean;
  robots: boolean;
}

export interface FetchResult {
  resolved: boolean;
  reason?: string;
  status?: number;
  contentType?: string;
  tempPath?: string;
  title?: string;
}

type FetchFn = (url: string, init?: any) => Promise<Response>;

export class GatedFetcher {
  private fetched = 0; // per-run budget counter
  private readonly robotsCache = new Map<string, string[]>(); // host → Disallow paths

  constructor(
    private readonly opts: GatedFetcherOptions,
    private readonly llm: ILLMProvider,
    private readonly logger: Logger,
    private readonly tempDir: string = "./temp",
    private readonly fetchFn: FetchFn = (globalThis as any).fetch
  ) {}

  /** True if the URL's host/prefix is allowlisted (and not rejectlisted). */
  private allowed(url: string): boolean {
    if (this.opts.rejectlist.some((p) => this.matches(url, p))) return false;
    return this.opts.allowlist.some((p) => this.matches(url, p));
  }

  private matches(url: string, pattern: string): boolean {
    if (url.startsWith(pattern)) return true; // prefix match
    try {
      const host = new URL(url).hostname;
      return host === pattern || host.endsWith(`.${pattern}`); // domain / subdomain
    } catch {
      return false;
    }
  }

  /** Minimal robots.txt check for `User-agent: *` Disallow rules (fail-open). */
  private async robotsBlocked(url: string): Promise<boolean> {
    if (!this.opts.robots) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!this.robotsCache.has(u.host)) {
      const disallow: string[] = [];
      try {
        const res = await this.timedFetch(`${u.protocol}//${u.host}/robots.txt`);
        if (res.ok) {
          let inStar = false;
          for (const raw of (await res.text()).split("\n")) {
            const line = raw.replace(/#.*$/, "").trim();
            const ua = /^user-agent:\s*(.+)$/i.exec(line);
            if (ua) inStar = ua[1].trim() === "*";
            else if (inStar) {
              const d = /^disallow:\s*(.*)$/i.exec(line);
              if (d && d[1].trim()) disallow.push(d[1].trim());
            }
          }
        }
      } catch {
        /* fail-open: unreachable robots ⇒ not blocked (allowlist is the real gate) */
      }
      this.robotsCache.set(u.host, disallow);
    }
    return this.robotsCache.get(u.host)!.some((p) => u.pathname.startsWith(p));
  }

  private timedFetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    return this.fetchFn(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
    }).finally(() => clearTimeout(timer));
  }

  async fetch(url: string, scope: string): Promise<FetchResult> {
    if (!this.allowed(url)) return { resolved: false, reason: "not-allowlisted" };
    if (await this.robotsBlocked(url)) return { resolved: false, reason: "robots-disallow" };
    if (this.fetched >= this.opts.maxFetches) return { resolved: false, reason: "budget-exceeded" };

    this.fetched++;
    let res: Response;
    try {
      res = await this.timedFetch(url);
    } catch (err: any) {
      const reason = err?.name === "AbortError" ? "timeout" : "fetch-error";
      this.logger.warn(`Fetch ${reason} for ${url}: ${err?.message ?? err}`);
      return { resolved: false, reason, status: 0 };
    }
    if (!res.ok) return { resolved: false, reason: `http-${res.status}`, status: res.status };

    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      return { resolved: false, reason: `content-type:${contentType.split(";")[0] || "unknown"}`, status: res.status, contentType };
    }

    const body = await res.text();
    if (Buffer.byteLength(body) > this.opts.maxBytes) {
      return { resolved: false, reason: "too-large", status: res.status, contentType };
    }

    const title = this.extractTitle(body);
    if (this.opts.relevanceCheck && !(await this.relevant(url, title, body, scope))) {
      return { resolved: false, reason: "irrelevant", status: res.status, contentType, title };
    }

    const tempPath = await this.stage(url, body);
    return { resolved: true, status: res.status, contentType, tempPath, title };
  }

  private extractTitle(html: string): string {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const d = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html);
    return [t?.[1]?.trim(), d?.[1]?.trim()].filter(Boolean).join(" — ").slice(0, 400);
  }

  /** Cheap LLM gate before the expensive extraction (fail-open on error). */
  private async relevant(url: string, title: string, html: string, scope: string): Promise<boolean> {
    try {
      const res = await this.llm.generateStructured(
        [
          {
            role: "system",
            content:
              "You decide if a web page is relevant to a knowledge-graph's scope. " +
              "Answer only by setting `relevant` true or false.",
          },
          {
            role: "user",
            content: `Scope: ${scope || "(general)"}\nURL: ${url}\nTitle/desc: ${title || "(none)"}\nRelevant?`,
          },
        ],
        z.object({ relevant: z.boolean() })
      );
      return res.relevant === true;
    } catch (err) {
      this.logger.warn(`Relevance check failed for ${url} (treating as relevant): ${err}`);
      return true;
    }
  }

  private async stage(url: string, body: string): Promise<string> {
    await fs.promises.mkdir(this.tempDir, { recursive: true });
    const name = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
    const p = path.join(this.tempDir, `${name}.html`);
    await fs.promises.writeFile(p, body, "utf-8");
    return p;
  }
}
