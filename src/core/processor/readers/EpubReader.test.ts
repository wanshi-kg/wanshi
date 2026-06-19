import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import AdmZip from "adm-zip";
import { EpubReader } from "./EpubReader";
import { TextChunker } from "../chunking/TextChunker";
import { stubLogger } from "../../../__tests__/helpers";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
const OPF = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
const CHAP1 = `<html><head><title>Chapter One</title></head><body><h1>Chapter One</h1><p>The owl flew over Sarny at dawn.</p></body></html>`;
const CHAP2 = `<html><head><title>Chapter Two</title></head><body><h1>Chapter Two</h1><p>Alex fed the strays before work.</p></body></html>`;

describe("EpubReader", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgepub-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const reader = (maxChunkSize = 4000) => {
    const chunker = new TextChunker({ maxChunkSize, overlapSize: 50, enabled: true }, stubLogger());
    return new EpubReader(chunker, stubLogger(), maxChunkSize);
  };

  const makeEpub = (): string => {
    const zip = new AdmZip();
    zip.addFile("META-INF/container.xml", Buffer.from(CONTAINER));
    zip.addFile("OEBPS/content.opf", Buffer.from(OPF));
    zip.addFile("OEBPS/chap1.xhtml", Buffer.from(CHAP1));
    zip.addFile("OEBPS/chap2.xhtml", Buffer.from(CHAP2));
    const p = path.join(tmp, "book.epub");
    zip.writeZip(p);
    return p;
  };

  it("reads spine chapters → text, headings, HTML stripped; chunks don't span chapters", async () => {
    const res = await reader().read(makeEpub());
    expect(res.metadata?.chapters).toBe(2);
    expect(res.chunks.length).toBeGreaterThanOrEqual(2);
    const c1 = res.chunks[0].content;
    const c2 = res.chunks[1].content;
    expect(c1).toContain("# Chapter One");
    expect(c1).toContain("The owl flew over Sarny at dawn.");
    expect(c1).not.toContain("Chapter Two"); // chapter-boundary: no spanning
    expect(c2).toContain("Alex fed the strays before work.");
    expect(c1).not.toContain("<p>"); // HTML stripped
    expect(c1).not.toContain("<h1>");
  });

  it("returns no chunks (no throw) for a .epub that is not a zip", async () => {
    const p = path.join(tmp, "broken.epub");
    fs.writeFileSync(p, "this is plainly not a zip archive");
    const res = await reader().read(p);
    expect(res.chunks).toEqual([]);
  });

  it("claims .epub and defers other extensions", () => {
    const r = reader();
    expect(r.canRead("/x/book.epub")).toBe(true);
    expect(r.canRead("/x/notes.md")).toBe(false);
    expect(r.adapterId()).toBe("epub");
  });
});
