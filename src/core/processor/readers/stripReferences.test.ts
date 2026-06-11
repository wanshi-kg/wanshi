import { splitTrailingReferences, splitPagesAtReferences } from "./stripReferences";
import { extractArxivId } from "./PdfReader";

const body = Array.from({ length: 30 }, (_, i) => `Body line ${i} with real content.`).join("\n");

describe("splitTrailingReferences", () => {
  it("splits at a trailing markdown References heading", () => {
    const refs = "## References\n[1] A. Author. Some cited paper. 2024.\n[2] B. Thirion et al.";
    const { body: kept, references } = splitTrailingReferences(`${body}\n${refs}`);
    expect(kept).toBe(body);
    expect(references).toContain("B. Thirion");
  });

  it("splits at a bare 'References' line and a numbered 'Bibliography'", () => {
    expect(splitTrailingReferences(`${body}\nReferences\n[1] x`).references).toBeDefined();
    expect(splitTrailingReferences(`${body}\n7. Bibliography\n[1] x`).references).toBeDefined();
  });

  it("returns the document unchanged when no references section exists", () => {
    const { body: kept, references } = splitTrailingReferences(body);
    expect(kept).toBe(body);
    expect(references).toBeUndefined();
  });

  it("ignores a References heading early in the document (not the bibliography)", () => {
    const doc = `# Intro\n## References\nWe discuss references as a concept here.\n${body}`;
    expect(splitTrailingReferences(doc).references).toBeUndefined();
  });

  it("does not match inline mentions ('see References below')", () => {
    const doc = `${body}\nAs noted, see References below for details.\nFinal line.`;
    expect(splitTrailingReferences(doc).references).toBeUndefined();
  });
});

describe("splitPagesAtReferences", () => {
  const page = (n: number) => `Page ${n} content.\n` + "x".repeat(200);

  it("truncates the heading page and drops subsequent pages", () => {
    const pages = [page(1), page(2), page(3), `Closing remarks.\nReferences\n[1] cited`, "more refs\n[2] cited"];
    const res = splitPagesAtReferences(pages);
    expect(res.pages).toHaveLength(4);
    expect(res.pages[3]).toBe("Closing remarks.");
    expect(res.references).toContain("[2] cited");
  });

  it("drops the heading page entirely when nothing precedes the heading on it", () => {
    const pages = [page(1), page(2), page(3), page(4), "References\n[1] cited"];
    const res = splitPagesAtReferences(pages);
    expect(res.pages).toHaveLength(4);
    expect(res.references).toContain("[1] cited");
  });

  it("returns pages unchanged without a references heading", () => {
    const pages = [page(1), page(2)];
    expect(splitPagesAtReferences(pages)).toEqual({ pages });
  });
});

describe("extractArxivId", () => {
  it("extracts the sidebar arXiv stamp with version", () => {
    expect(extractArxivId("arXiv:2605.22391v1 [cs.CL] 21 May 2026")).toBe("2605.22391v1");
    expect(extractArxivId("arXiv: 2604.22776")).toBe("2604.22776");
  });

  it("returns undefined when absent", () => {
    expect(extractArxivId("no identifiers here")).toBeUndefined();
  });
});
