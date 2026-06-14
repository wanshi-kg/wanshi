import {
  extractBareUrls,
  extractCitations,
  extractHtmlLinks,
  extractMarkdownLinks,
  isExternalTarget,
} from "./referenceExtraction";

describe("extractBareUrls", () => {
  it("captures web-clip `> source:` frontmatter and bare URLs, deduped", () => {
    const md = [
      "# Title | Letta",
      "> source: https://www.letta.com/blog/sleep-time-compute",
      "> kind: article",
      "Source: https://youtu.be/abc?si=xyz",
      "see https://www.letta.com/blog/sleep-time-compute again", // dup
    ].join("\n");
    const urls = extractBareUrls(md).map((l) => l.target);
    expect(urls).toEqual([
      "https://www.letta.com/blog/sleep-time-compute",
      "https://youtu.be/abc?si=xyz",
    ]);
    expect(extractBareUrls(md).every((l) => l.kind === "url")).toBe(true);
  });

  it("trims trailing punctuation", () => {
    expect(extractBareUrls("ref: https://example.com/p.").map((l) => l.target)).toEqual([
      "https://example.com/p",
    ]);
  });
});

describe("isExternalTarget", () => {
  it("flags protocol/protocol-relative/mailto targets as external", () => {
    expect(isExternalTarget("https://example.com")).toBe(true);
    expect(isExternalTarget("http://x")).toBe(true);
    expect(isExternalTarget("//cdn.example.com/x")).toBe(true);
    expect(isExternalTarget("mailto:a@b.c")).toBe(true);
  });
  it("treats relative/absolute file paths as internal", () => {
    expect(isExternalTarget("./other.md")).toBe(false);
    expect(isExternalTarget("../docs/a.md")).toBe(false);
    expect(isExternalTarget("notes/b.md")).toBe(false);
    expect(isExternalTarget("/abs/path.md")).toBe(false);
  });
});

describe("extractMarkdownLinks", () => {
  it("extracts inline links but not images", () => {
    const md =
      "See [other](./other.md) and ![diagram](diagram.png) plus [site](https://x.io).";
    const links = extractMarkdownLinks(md);
    const targets = links.map((l) => l.target);
    expect(targets).toContain("./other.md");
    expect(targets).toContain("https://x.io");
    expect(targets).not.toContain("diagram.png"); // image excluded
  });

  it("ignores pure-fragment links and captures link text", () => {
    const links = extractMarkdownLinks("[top](#section) and [doc](a.md)");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ target: "a.md", text: "doc", kind: "markdown" });
  });

  it("extracts wikilinks with and without aliases", () => {
    const links = extractMarkdownLinks("[[Some Note]] and [[Target|shown]]");
    expect(links).toEqual([
      { target: "Some Note", text: undefined, kind: "wikilink" },
      { target: "Target", text: "shown", kind: "wikilink" },
    ]);
  });
});

describe("extractHtmlLinks", () => {
  it("extracts anchor hrefs and strips inner markup, ignoring fragments", () => {
    const html =
      '<a href="./a.html"><b>A</b></a> <a href="#top">top</a> <a href="https://x">X</a>';
    const links = extractHtmlLinks(html);
    expect(links.map((l) => l.target)).toEqual(["./a.html", "https://x"]);
    expect(links[0]).toMatchObject({ text: "A", kind: "html" });
  });
});

describe("extractCitations", () => {
  it("parses a BibTeX block via Citation.js (title + DOI)", () => {
    const bib = `@article{doe2020,
      author = {Doe, Jane},
      title = {An Example Study},
      year = {2020},
      doi = {10.1234/example.2020}
    }`;
    const cites = extractCitations(bib, "");
    expect(cites).toHaveLength(1);
    expect(cites[0].title).toBe("An Example Study");
    expect(cites[0].doi).toBe("10.1234/example.2020");
  });

  it("falls back to regex on a prose bibliography (arXiv/DOI/PMID)", () => {
    const block = [
      "References",
      "[1] Smith, J. (2020). A study of things. arXiv:2001.12345.",
      "[2] Lee, K. (2019). Another paper. doi:10.5555/abc.def. PMID: 31234567.",
    ].join("\n");
    const cites = extractCitations(block, "");
    expect(cites).toHaveLength(2);
    expect(cites[0].arxivId).toBe("2001.12345");
    expect(cites[1].doi).toBe("10.5555/abc.def");
    expect(cites[1].pmid).toBe("31234567");
  });

  it("picks up inline ids in the body and dedupes against the block", () => {
    const block = "References\n[1] Foo. arXiv:2001.12345.";
    const body = "As shown in arXiv:2001.12345 and also arXiv:2222.00001 we find...";
    const cites = extractCitations(block, body);
    const arxiv = cites.map((c) => c.arxivId).filter(Boolean).sort();
    expect(arxiv).toEqual(["2001.12345", "2222.00001"]); // 2001 not duplicated
  });

  it("returns [] when there is nothing to extract", () => {
    expect(extractCitations(undefined, "plain text, no ids")).toEqual([]);
  });
});
