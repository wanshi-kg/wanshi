import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DirectoryProcessor } from "./DirectoryProcessor";
import { ContainerFactory, TYPES } from "./di";
import { GatedFetcher } from "./knowledge/references/web/GatedFetcher";
import { makeConfig, stubLogger } from "../__tests__/helpers";

/**
 * Phase-1 class-3 web fetch e2e — REAL readers + worklist + WebReferenceProcessor,
 * with the GatedFetcher's network mocked (canned HTML) and the LLM builder stubbed.
 * Proves: allowlisted external `> source:` URLs → resolved references edges;
 * off-allowlist → resolved:false (no network); web off → no fetch.
 */
describe("DirectoryProcessor — class-3 web fetch (Phase 1) e2e", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgweb-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (rel: string, content: string) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  const stubLlm = { generateStructured: async () => ({}), getModelCapabilities: async () => [] } as any;
  const cannedHtml = "<html><head><title>Article</title></head><body>content</body></html>";

  const buildContainer = (config: any, fetchFn: any) => {
    const container = ContainerFactory.createContainer({ processingOptions: config });
    container.registerValue(TYPES.KnowledgeGraphBuilder, {
      build: async () => [],
      getFailedChunks: () => [],
      getGroundingRejections: () => [],
    } as any);
    // Override the gated fetcher with a mocked-network instance (allowlist still enforced).
    container.registerValue(
      TYPES.GatedFetcher,
      new GatedFetcher(
        { allowlist: ["example.com"], rejectlist: [], maxFetches: 50, timeoutMs: 1000, maxBytes: 1_000_000, relevanceCheck: false, robots: false },
        stubLlm,
        stubLogger(),
        path.join(tmp, "temp"),
        fetchFn
      )
    );
    return container;
  };

  const webConfig = () =>
    makeConfig({
      input: tmp,
      filter: ["**/*.md"],
      output: path.join(tmp, "out.json"),
      description: "ML notes",
      retrieval: { mode: "disabled" },
      classifier: { mode: "disabled" },
      references: { web: { enabled: true, allowlist: ["example.com"], relevanceCheck: false, robots: false } },
    });

  it("fetches allowlisted external source URLs (resolved) and skips off-allowlist (resolved:false, no network)", async () => {
    write("a.md", "# A\n> source: https://example.com/article\n\nbody\n");
    write("b.md", "# B\n> source: https://evil.com/x\n\nbody\n");

    const fetchFn = jest.fn(async (_url: string) =>
      new Response(cannedHtml, { status: 200, headers: { "content-type": "text/html" } })
    );
    const container = buildContainer(webConfig(), fetchFn);
    const graphs = await new DirectoryProcessor(container).processFiles(
      [path.join(tmp, "a.md"), path.join(tmp, "b.md")],
      webConfig()
    );

    const refs = graphs.flatMap((g) => g.relations).filter((r) => r.relationType.includes("references"));
    expect(refs).toContainEqual(
      expect.objectContaining({ from: "a.md", to: "https://example.com/article", resolved: true })
    );
    expect(refs).toContainEqual(expect.objectContaining({ to: "https://evil.com/x", resolved: false }));
    expect(fetchFn).toHaveBeenCalledTimes(1); // only the allowlisted host hit the network
    expect(fetchFn.mock.calls[0][0]).toContain("example.com");
  });

  it("web disabled ⇒ no fetch, no references edges", async () => {
    write("a.md", "# A\n> source: https://example.com/article\n");
    const config = makeConfig({
      input: tmp,
      filter: ["**/*.md"],
      output: path.join(tmp, "out.json"),
      retrieval: { mode: "disabled" },
      classifier: { mode: "disabled" },
    });
    const fetchFn = jest.fn();
    const container = buildContainer(config, fetchFn);
    const graphs = await new DirectoryProcessor(container).processFiles([path.join(tmp, "a.md")], config);

    expect(graphs.flatMap((g) => g.relations).filter((r) => r.relationType.includes("references"))).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
