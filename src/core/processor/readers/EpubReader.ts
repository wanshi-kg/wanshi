import * as path from "path";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import type { HtmlToTextOptions } from "html-to-text";
import { ChunkResult, FileReader, FileReadResult } from "./FileReader";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

/** html-to-text profile for EPUB chapter XHTML — keep structure, drop chrome. */
const EPUB_HTML_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "h1", format: "heading", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: "h2", format: "heading", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
    { selector: "h3", format: "heading", options: { uppercase: false, leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "p", format: "paragraph", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "ul", format: "unorderedList", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "ol", format: "orderedList", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "li", format: "listItem" },
    { selector: "blockquote", format: "blockquote", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "nav", format: "skip" },
  ],
};

/**
 * Reads EPUB (`.epub`) into **chapter-boundary** chunks. An EPUB is a ZIP of
 * XHTML documents ordered by the OPF spine; this reader unzips (adm-zip), reads
 * the spine (cheerio xmlMode — the `GrobidClient` precedent, no new XML dep),
 * converts each chapter's XHTML to text (html-to-text), and chunks **each
 * chapter separately** (re-indexed across all) so a chunk never spans two
 * chapters. `sourceAdapter:"epub"` is stamped centrally from `adapterId()`.
 *
 * v1 deferred: TOC/nav-driven chapter titles, embedded images, EPUB3 nav specifics.
 */
export class EpubReader extends FileReader {
  private readonly maxChunkSize: number;

  constructor(chunker: TextChunker, logger: Logger, maxChunkSize: number) {
    super([".epub"], chunker, logger);
    this.maxChunkSize = maxChunkSize;
  }

  getName(): string {
    return "EpubReader";
  }

  adapterId(): string {
    return "epub";
  }

  async read(filePath: string): Promise<FileReadResult> {
    try {
      const zip = new AdmZip(filePath);
      const opfPath = this.findOpfPath(zip);
      if (!opfPath) {
        this.logger.warn(`EpubReader: no OPF rootfile in ${filePath}`);
        return { chunks: [], metadata: { type: "epub-error" } };
      }
      const chapters = await this.readChapters(zip, opfPath);
      if (chapters.length === 0) return { chunks: [], metadata: { type: "epub-empty" } };

      // Chunk each chapter independently, then re-index so no chunk spans two.
      const all: ChunkResult[] = [];
      for (const ch of chapters) {
        const text = (ch.title ? `# ${ch.title}\n\n` : "") + ch.text;
        if (!text.trim()) continue;
        for (const p of await this.chunker.chunk(text)) all.push({ ...p });
      }
      all.forEach((c, i) => {
        c.index = i + 1;
        c.totalChunks = all.length;
      });
      return { chunks: all, metadata: { type: "epub", chapters: chapters.length } };
    } catch (e) {
      this.logger.warn(`EpubReader could not parse ${filePath}: ${e}`);
      return { chunks: [], metadata: { type: "epub-error" } };
    }
  }

  /** META-INF/container.xml → the OPF package path. */
  private findOpfPath(zip: AdmZip): string | undefined {
    const container = zip.getEntry("META-INF/container.xml");
    if (!container) return undefined;
    const $ = cheerio.load(zip.readAsText(container), { xmlMode: true });
    return $("rootfile").first().attr("full-path") || undefined;
  }

  /** OPF manifest+spine → ordered chapter {title, text}. */
  private async readChapters(zip: AdmZip, opfPath: string): Promise<{ title?: string; text: string }[]> {
    const $ = cheerio.load(zip.readAsText(opfPath), { xmlMode: true });
    const hrefById = new Map<string, string>();
    $("manifest item").each((_, el) => {
      const id = $(el).attr("id");
      const href = $(el).attr("href");
      if (id && href) hrefById.set(id, href);
    });
    const opfDir = path.posix.dirname(opfPath.split(path.sep).join("/"));

    const chapters: { title?: string; text: string }[] = [];
    const spine = $("spine itemref").toArray();
    for (const el of spine) {
      const href = hrefById.get($(el).attr("idref") || "");
      if (!href) continue;
      const entryName = opfDir === "." ? href : `${opfDir}/${href}`;
      const entry = zip.getEntry(entryName) ?? zip.getEntry(decodeURIComponent(entryName));
      if (!entry) continue;
      const xhtml = zip.readAsText(entry);
      const { title, text } = await this.xhtmlToChapter(xhtml);
      if (text.trim()) chapters.push({ title, text });
    }
    return chapters;
  }

  private async xhtmlToChapter(xhtml: string): Promise<{ title?: string; text: string }> {
    const $ = cheerio.load(xhtml);
    const title = ($("title").first().text() || $("h1").first().text() || "").trim() || undefined;
    const { convert } = await import("html-to-text");
    return { title, text: convert(xhtml, EPUB_HTML_OPTIONS) };
  }
}
