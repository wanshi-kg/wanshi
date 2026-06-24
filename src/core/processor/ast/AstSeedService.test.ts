import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AstSeedService } from "./AstSeedService";
import { AstSymbolStore } from "./AstSymbolStore";
import { hashContent } from "../../../shared/utils/astSymbols";
import { allowedEntityTypes, allowedRelationTypes } from "../../knowledge/vocabulary";
import { ProcessedFile } from "../../../types";
import { stubLogger } from "../../../__tests__/helpers";

const TS = `import { z } from "./z";
export function countTerms(text) { return helper(text); }
function helper(t) { return t; }
export const VERSION = "1.0";
let scratch = 0;
export class Tokenizer {
  private secret = 1;
  tokenize(s) { return countTerms(s); }
}
`;

describe("AstSeedService (Phase 8)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgast-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const service = () => new AstSeedService(new AstSymbolStore(path.join(tmp, "c.json"), stubLogger()), stubLogger(), tmp);
  const tsFile = (content = TS): ProcessedFile =>
    ({ path: path.join(tmp, "tok.ts"), content, chunks: [] } as any);

  it("seeds definitions (countTerms, class, method); skips a private member", async () => {
    const g = (await service().seedGraph(tsFile()))!;
    expect(g).not.toBeNull();
    const names = g.entities.map((e) => e.name);
    expect(names).toContain("countTerms"); // the symbol all five models missed
    expect(names).toContain("helper"); // non-exported definition still seeded
    expect(names).toContain("Tokenizer"); // class
    expect(names).toContain("tokenize"); // method (definition kind → always)
    expect(names).not.toContain("secret"); // private property (member, not exported) → skipped
    expect(names).not.toContain("scratch"); // local variable → not a definition/exported member
  });

  it("every seeded type/predicate is in the closed Phase-2 vocabulary", async () => {
    const g = (await service().seedGraph(tsFile()))!;
    const types = new Set(allowedEntityTypes());
    const preds = new Set(allowedRelationTypes());
    for (const e of g.entities) expect(types.has(e.entityType)).toBe(true);
    for (const r of g.relations) for (const p of r.relationType) expect(preds.has(p)).toBe(true);
  });

  it("emits calls + imports edges (imports → depends_on on a dependency entity)", async () => {
    const g = (await service().seedGraph(tsFile()))!;
    expect(g.relations.some((r) => r.relationType.includes("calls"))).toBe(true);
    const dep = g.relations.find((r) => r.relationType.includes("depends_on"));
    expect(dep).toBeDefined();
    expect(g.entities.some((e) => e.name === dep!.to && e.entityType === "dependency")).toBe(true);
  });

  it("is a no-op on unchanged content: uses the cached table instead of re-parsing", async () => {
    const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
    const content = "export function real() {}";
    // Pre-seed the cache with a SENTINEL the real parser would never produce.
    // Key form mirrors AstSeedService: `${ext}::${content}` (WS-31), ext = "ts" (tok.ts).
    store.set(hashContent("ts::" + content), {
      schemaVersion: 1,
      symbols: [{ name: "SENTINEL", qualifiedName: "SENTINEL", kind: "function", span: { startLine: 1, endLine: 1 }, exported: true }],
      references: [],
    });
    const svc = new AstSeedService(store, stubLogger(), tmp);
    const g = (await svc.seedGraph(tsFile(content)))!;
    expect(g.entities.map((e) => e.name)).toEqual(["SENTINEL"]); // cache hit, not re-parsed
  });

  it("returns null for a non-code file (no throw)", async () => {
    const txt: ProcessedFile = { path: path.join(tmp, "notes.txt"), content: "just prose", chunks: [] } as any;
    expect(await service().seedGraph(txt)).toBeNull();
  });

  // WS-09: cache-the-failure. An empty extraction (parse failure / unknown ext)
  // must NOT be persisted, so a later successful run re-extracts.
  describe("cache-the-failure (WS-09)", () => {
    const emptyTable = { schemaVersion: 1 as const, symbols: [], references: [] };
    const goodTable = {
      schemaVersion: 1 as const,
      symbols: [
        { name: "later", qualifiedName: "later", kind: "function" as const, span: { startLine: 1, endLine: 1 }, exported: true },
      ],
      references: [],
    };

    it("does NOT cache an empty extraction (extractSymbolsSafe returns empty, not undefined)", async () => {
      const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
      const svc = new AstSeedService(store, stubLogger(), tmp);
      const extract = jest.fn().mockResolvedValue(emptyTable);
      (svc as any).generator = { isSupported: () => true, extractSymbolsSafe: extract };

      const content = "broken or unparseable for this pass";
      const file = tsFile(content);
      expect(await svc.seedGraph(file)).toBeNull();
      // The hash for this content must NOT be in the cache (empty table not stored).
      expect(store.get(hashContent(content))).toBeUndefined();
    });

    it("re-extracts on a later run once the cause is fixed (no poisoned cache)", async () => {
      const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
      const svc = new AstSeedService(store, stubLogger(), tmp);
      const content = "export function later() {}";
      const extract = jest.fn().mockResolvedValueOnce(emptyTable).mockResolvedValueOnce(goodTable);
      (svc as any).generator = { isSupported: () => true, extractSymbolsSafe: extract };

      // First run: transient failure → null, nothing cached.
      expect(await svc.seedGraph(tsFile(content))).toBeNull();
      // Second run, same content: cache was NOT poisoned, so it re-extracts and now succeeds.
      const g = await svc.seedGraph(tsFile(content));
      expect(g).not.toBeNull();
      expect(g!.entities.map((e) => e.name)).toContain("later");
      expect(extract).toHaveBeenCalledTimes(2);
    });

    it("gates by isSupported — an unknown extension never reaches extraction or the cache", async () => {
      const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
      const svc = new AstSeedService(store, stubLogger(), tmp);
      const extract = jest.fn().mockResolvedValue(goodTable);
      (svc as any).generator = { isSupported: () => false, extractSymbolsSafe: extract };

      const content = "anything";
      const file: ProcessedFile = { path: path.join(tmp, "weird.xyz"), content, chunks: [] } as any;
      expect(await svc.seedGraph(file)).toBeNull();
      expect(extract).not.toHaveBeenCalled();
      expect(store.get(hashContent(content))).toBeUndefined();
    });
  });

  // WS-31: byte-identical files of different extensions parse under different
  // grammars; the cache key must include the extension so a `.js` lookup can't
  // reuse a `.ts` parse.
  describe("ext-collision cache key (WS-31)", () => {
    const sym = (name: string) =>
      ({ name, qualifiedName: name, kind: "function" as const, span: { startLine: 1, endLine: 1 }, exported: true });

    it("does not return a .ts parse for a byte-identical .js file (no cross-ext collision)", async () => {
      const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
      const svc = new AstSeedService(store, stubLogger(), tmp);
      // The SAME byte content; the mock simulates two grammars yielding distinct symbols.
      const content = "const foo = 42;\n";
      const extract = jest.fn(async (_c: string, ext: string) => ({
        schemaVersion: 1 as const,
        symbols: [sym(ext === "ts" ? "fromTS" : "fromJS")],
        references: [],
      }));
      (svc as any).generator = { isSupported: () => true, extractSymbolsSafe: extract };

      const tsf: ProcessedFile = { path: path.join(tmp, "same.ts"), content, chunks: [] } as any;
      const jsf: ProcessedFile = { path: path.join(tmp, "same.js"), content, chunks: [] } as any;

      const gts = (await svc.seedGraph(tsf))!;
      const gjs = (await svc.seedGraph(jsf))!;

      // Each extension parsed independently — no cache hit leaked across them.
      expect(gts.entities.map((e) => e.name)).toContain("fromTS");
      expect(gjs.entities.map((e) => e.name)).toContain("fromJS");
      expect(gjs.entities.map((e) => e.name)).not.toContain("fromTS");
      expect(extract).toHaveBeenCalledTimes(2); // both files parsed, distinct cache keys
    });

    it("still a no-op on the SAME file (same content + ext) — cache hit, one parse", async () => {
      const store = new AstSymbolStore(path.join(tmp, "c.json"), stubLogger());
      const svc = new AstSeedService(store, stubLogger(), tmp);
      const content = "const foo = 42;\n";
      const extract = jest.fn(async () => ({ schemaVersion: 1 as const, symbols: [sym("foo")], references: [] }));
      (svc as any).generator = { isSupported: () => true, extractSymbolsSafe: extract };

      const f: ProcessedFile = { path: path.join(tmp, "same.ts"), content, chunks: [] } as any;
      await svc.seedGraph(f);
      await svc.seedGraph(f);
      expect(extract).toHaveBeenCalledTimes(1); // second call served from cache
    });
  });
});
