import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";
import { FileReader, FileReadResult } from "./FileReader";
import { splitPagesAtReferences } from "./stripReferences";
import { extractCitations, RawReferences } from "./referenceExtraction";
import PDFParser from "pdf2json";

/**
 * Extract an arXiv identifier from page text (the sidebar/footer stamp on
 * arXiv-hosted PDFs). Pure — exported for tests.
 */
export function extractArxivId(text: string): string | undefined {
  const m = text.match(/arXiv:\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return m ? m[1] : undefined;
}

/**
 * Reader for PDF files
 */
export class PdfReader extends FileReader {
  constructor(
    chunker: TextChunker,
    logger: Logger,
    private readonly stripReferences: boolean = false,
    private readonly extractCites: boolean = false
  ) {
    super([".pdf"], chunker, logger);
  }

  getName(): string {
    return "PdfReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      this.logger.debug(`Reading PDF file: ${filePath}`);

      let { pages: content, title } = await this.readPdfPages(filePath);

      // Document identity is captured here, at ingest time — never extracted
      // from body text, which is full of OTHER papers' arXiv IDs (citations).
      const arxivId = extractArxivId(content.slice(0, 2).join("\n"));

      // Detect the trailing bibliography once if either consumer needs it.
      const split =
        this.stripReferences || this.extractCites
          ? splitPagesAtReferences(content)
          : undefined;

      // Phase 0 citation extraction (network-free), gated by config. Drop the
      // paper's OWN arXiv id (the host identity, not a citation).
      let references: RawReferences | undefined;
      if (this.extractCites) {
        const cites = extractCitations(split?.references, content.join("\n")).filter(
          (c) => !arxivId || c.arxivId !== arxivId
        );
        if (cites.length) references = { citations: cites };
      }

      if (this.stripReferences && split?.references) {
        this.logger.info(
          `Quarantined trailing references section of ${filePath} ` +
            `(${split.references.length} chars, ${content.length - split.pages.length} page(s) dropped)`
        );
        content = split.pages;
      }

      const chunks = content.map((page, index) => {
        const startOffset = content.slice(0, index).reduce((acc, curr) => acc + curr.length, 0);
        return {
          content: page,
          startOffset: startOffset,
          endOffset: startOffset + page.length,
          index: index + 1,
          totalChunks: content.length
        };
      });

      return {
        chunks: chunks,
        metadata: {
          type: "pdf",
          fileName: filePath,
          ...(arxivId ? { arxivId } : {}),
          ...(title ? { title } : {}),
          ...(references ? { references } : {}),
        },
      };
    } catch (error) {
      this.logger.error(`Failed to read PDF file ${filePath}: ${error}`);
      throw new Error(`Failed to read PDF file: ${error}`);
    }
  }

  private readPdfPages(filePath: string): Promise<{ pages: string[]; title?: string }> {
    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on("pdfParser_dataError", (errData) =>
        reject(errData.parserError)
      );

      pdfParser.on("pdfParser_dataReady", (pdfData) => {
        const pages = pdfData.Pages.map((page) =>
          page.Texts.map((t) =>
            t.R.map((r) => decodeURIComponent(r.T)).join("")
          ).join("\n")
        );
        const rawTitle = (pdfData as any).Meta?.Title;
        let title: string | undefined;
        if (typeof rawTitle === "string" && rawTitle.trim()) {
          try {
            title = decodeURIComponent(rawTitle).trim();
          } catch {
            title = rawTitle.trim();
          }
        }
        resolve({ pages, title });
      });

      pdfParser.loadPDF(filePath);
    });
  }
}
