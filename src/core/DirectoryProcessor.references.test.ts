import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DirectoryProcessor } from "./DirectoryProcessor";
import { ContainerFactory, TYPES } from "./di";
import { makeConfig } from "../__tests__/helpers";

/**
 * End-to-end seam for Phase-0 reference resolution: REAL FileProcessor/readers
 * (so reading actually populates `metadata.references`) + a STUBBED LLM builder
 * (so the only edges are the deterministic reference edges). Asserts on the
 * pre-merge per-file graphs from `processFiles` — network-free.
 */
describe("DirectoryProcessor — reference resolution (Phase 0) e2e", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgref-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  const stubBuilder = (container: any) =>
    container.registerValue(TYPES.KnowledgeGraphBuilder, {
      build: async () => [],
      getFailedChunks: () => [],
      getGroundingRejections: () => [],
    } as any);

  const linkRels = (graphs: { relations: any[] }[]) =>
    graphs.flatMap((g) => g.relations).filter((r) => r.relationType.includes("links_to"));

  it("emits resolved links_to edges between corpus files + a stub for a missing target", async () => {
    write("a.md", "# A\n\nSee [B](./b.md) and [gone](./nope.md) and [ext](https://x.io).\n");
    write("b.md", "# B\n\nBack to [A](./a.md).\n");

    const config = makeConfig({
      input: tmp,
      filter: ["**/*.md"],
      output: path.join(tmp, "out.json"),
      references: { internalLinks: { enabled: true }, citations: { enabled: false } },
      retrieval: { mode: "disabled" },
      classifier: { mode: "disabled" },
    });

    const container = ContainerFactory.createContainer({ processingOptions: config });
    stubBuilder(container);

    const graphs = await new DirectoryProcessor(container).processFiles(
      [path.join(tmp, "a.md"), path.join(tmp, "b.md")],
      config
    );

    const rels = linkRels(graphs);
    expect(rels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "a.md", to: "b.md", resolved: true, source: "a.md" }),
        expect.objectContaining({ from: "b.md", to: "a.md", resolved: true, source: "b.md" }),
        expect.objectContaining({ from: "a.md", to: "./nope.md", resolved: false }),
      ])
    );
    // external link is left for the network phase — no edge
    expect(rels.some((r) => String(r.to).includes("x.io"))).toBe(false);

    // every links_to endpoint exists as a document node (so the merger keeps it)
    const names = new Set(graphs.flatMap((g) => g.entities).map((e) => e.name));
    for (const r of rels) {
      expect(names.has(r.from)).toBe(true);
      expect(names.has(r.to)).toBe(true);
    }
  });

  it("default run (references off) adds no reference edges", async () => {
    write("a.md", "See [B](./b.md).\n");
    write("b.md", "# B\n");

    const config = makeConfig({
      input: tmp,
      filter: ["**/*.md"],
      output: path.join(tmp, "out.json"),
      retrieval: { mode: "disabled" },
      classifier: { mode: "disabled" },
    });

    const container = ContainerFactory.createContainer({ processingOptions: config });
    stubBuilder(container);

    const graphs = await new DirectoryProcessor(container).processFiles(
      [path.join(tmp, "a.md"), path.join(tmp, "b.md")],
      config
    );

    expect(graphs.flatMap((g) => g.relations)).toEqual([]);
  });
});
