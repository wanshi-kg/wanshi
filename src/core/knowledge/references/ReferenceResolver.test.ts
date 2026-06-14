import { buildReferenceGraph } from "./ReferenceResolver";
import { ProcessedFile } from "../../../types";
import { RawReferences } from "../../processor/readers/referenceExtraction";

const ROOT = "/corpus";
const ALL = true;
const opts = { internalLinks: true, citations: true };

function file(rel: string, references: RawReferences): ProcessedFile {
  return {
    path: `${ROOT}/${rel}`,
    chunks: [],
    metadata: { references },
  };
}

describe("buildReferenceGraph — internal links", () => {
  const corpus = new Set(["docs/a.md", "docs/b.md", "notes/some-note.md"]);

  it("resolves a relative link to a corpus file (links_to, resolved:true)", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "./b.md", kind: "markdown" }] }),
      corpus,
      ROOT,
      opts
    )!;
    expect(g.relations).toEqual([
      { from: "docs/a.md", to: "docs/b.md", relationType: ["links_to"], source: "docs/a.md", resolved: true },
    ]);
    // both endpoints exist as document nodes (so the merger won't drop the edge)
    expect(g.entities.map((e) => e.name).sort()).toEqual(["docs/a.md", "docs/b.md"]);
    expect(g.entities.every((e) => e.entityType === "document")).toBe(true);
  });

  it("resolves a parent-relative link and adds .md when extensionless", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "../notes/some-note", kind: "markdown" }] }),
      corpus,
      ROOT,
      opts
    )!;
    expect(g.relations[0]).toMatchObject({ to: "notes/some-note.md", resolved: true });
  });

  it("emits a stub node + resolved:false for a missing target", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "./missing.md", kind: "markdown" }] }),
      corpus,
      ROOT,
      opts
    )!;
    expect(g.relations[0]).toMatchObject({ relationType: ["links_to"], resolved: false });
    const target = g.relations[0].to;
    expect(g.entities.find((e) => e.name === target)).toBeDefined(); // stub present
  });

  it("resolves a wikilink by file basename", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "Some Note", kind: "wikilink" }] }),
      corpus,
      ROOT,
      opts
    )!;
    expect(g.relations[0]).toMatchObject({ to: "notes/some-note.md", resolved: true });
  });

  it("skips external targets (left for the network phase)", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "https://example.com", kind: "markdown" }] }),
      corpus,
      ROOT,
      opts
    );
    expect(g).toBeNull(); // only the source node, no edges → null
  });

  it("drops a self-link", () => {
    const g = buildReferenceGraph(
      file("docs/a.md", { internalLinks: [{ target: "./a.md", kind: "markdown" }] }),
      corpus,
      ROOT,
      opts
    );
    expect(g).toBeNull();
  });
});

describe("buildReferenceGraph — citations", () => {
  it("emits cites edges (resolved:false) with stated ids as observations", () => {
    const g = buildReferenceGraph(
      file("papers/p.md", {
        citations: [
          { raw: "Foo et al.", arxivId: "2001.12345" },
          { raw: "Bar", doi: "10.1/xyz", title: "Bar Study" },
        ],
      }),
      new Set(),
      ROOT,
      opts
    )!;
    // Node name prefers a stable hard id (arXiv/DOI) over the title.
    expect(g.relations).toEqual([
      { from: "papers/p.md", to: "arXiv:2001.12345", relationType: ["cites"], source: "papers/p.md", resolved: false },
      { from: "papers/p.md", to: "doi:10.1/xyz", relationType: ["cites"], source: "papers/p.md", resolved: false },
    ]);
    const arxivNode = g.entities.find((e) => e.name === "arXiv:2001.12345")!;
    expect(arxivNode.observations.map((o) => o.text)).toContain("arXiv:2001.12345");
  });
});

describe("buildReferenceGraph — gating", () => {
  it("returns null when the file has no references metadata", () => {
    expect(buildReferenceGraph({ path: `${ROOT}/x.md`, chunks: [] }, new Set(), ROOT, opts)).toBeNull();
  });

  it("honors per-axis opts (citations off ⇒ no cites edges)", () => {
    const g = buildReferenceGraph(
      file("papers/p.md", { citations: [{ raw: "Foo", arxivId: "2001.12345" }] }),
      new Set(),
      ROOT,
      { internalLinks: ALL, citations: false }
    );
    expect(g).toBeNull();
  });
});
