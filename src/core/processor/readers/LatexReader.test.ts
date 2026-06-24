import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LatexReader } from "./LatexReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";
import { RawReferences } from "./referenceExtraction";

const TEX = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\title{My \\textbf{Great} Paper}",
  "\\author{Alice Smith}",
  "\\begin{document}",
  "\\maketitle",
  "% this is a comment that should vanish",
  "\\section{Introduction}",
  "This work builds on prior art \\cite{smith2020,jones2019}. See also \\citep{doe2021}.",
  "\\begin{figure}",
  "\\includegraphics{fig.png}",
  "\\caption{A noisy figure}",
  "\\end{figure}",
  "We use \\textbf{bold} and \\emph{emphasis}.",
  "\\end{document}",
].join("\n");

describe("LatexReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgtex-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (extractCites = false, maxChunkSize = 8000) => {
    const chunker = new TextChunker({ maxChunkSize, overlapSize: 50, enabled: true }, stubLogger());
    return new LatexReader(chunker, stubLogger(), extractCites);
  };
  const write = (content: string) => {
    const p = path.join(tmp, "paper.tex");
    fs.writeFileSync(p, content);
    return p;
  };

  it("de-TeX → clean body: headings, unwrapped formatting, title/author, no preamble/figure/comments", async () => {
    const res = await reader().read(write(TEX));
    const text = res.chunks.map((c) => c.content).join("\n");
    expect(text).toContain("My Great Paper"); // \textbf unwrapped in the lifted title
    expect(text).toContain("Alice Smith");
    expect(text).toContain("# Introduction"); // \section → heading
    expect(text).toContain("This work builds on prior art");
    expect(text).toContain("bold");
    expect(text).toContain("emphasis");
    expect(text).not.toContain("documentclass");
    expect(text).not.toContain("usepackage");
    expect(text).not.toContain("comment that should vanish");
    expect(text).not.toContain("A noisy figure"); // figure env dropped wholesale
    expect(text).not.toContain("\\cite");
    expect(text).not.toContain("\\textbf");
  });

  it("extracts \\cite keys into metadata.references.citations when enabled", async () => {
    const res = await reader(true).read(write(TEX));
    const refs = res.metadata?.references as RawReferences | undefined;
    expect(refs?.citations?.map((c) => c.raw)).toEqual(["smith2020", "jones2019", "doe2021"]);
  });

  it("emits no references when citation extraction is disabled", async () => {
    const res = await reader(false).read(write(TEX));
    expect((res.metadata as any)?.references).toBeUndefined();
  });

  it("WS-27: de-TeX does not leak environment names (itemize/abstract/enumerate) as orphan tokens", async () => {
    const tex = [
      "\\begin{document}",
      "\\begin{abstract}",
      "This is the abstract content.",
      "\\end{abstract}",
      "\\section{Body}",
      "\\begin{itemize}",
      "\\item First point about owls.",
      "\\item Second point about strays.",
      "\\end{itemize}",
      "\\begin{enumerate}",
      "\\item Ordered one.",
      "\\end{enumerate}",
      "\\end{document}",
    ].join("\n");
    const res = await reader().read(write(tex));
    const text = res.chunks.map((c) => c.content).join("\n");
    // content survives
    expect(text).toContain("This is the abstract content.");
    expect(text).toContain("First point about owls.");
    expect(text).toContain("Second point about strays.");
    expect(text).toContain("Ordered one.");
    // env names must NOT leak as orphan prose tokens
    expect(text).not.toMatch(/\bitemize\b/);
    expect(text).not.toMatch(/\benumerate\b/);
    // the lone word "abstract" must not appear as an orphan token on its own line
    expect(text).not.toMatch(/^\s*abstract\s*$/m);
    expect(text).not.toContain("\\begin");
    expect(text).not.toContain("\\end");
  });

  it("claims .tex and defers other extensions", () => {
    const r = reader();
    expect(r.canRead("/x/paper.tex")).toBe(true);
    expect(r.canRead("/x/notes.md")).toBe(false);
    expect(r.adapterId()).toBe("latex");
  });
});
