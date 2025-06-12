import { FileReader, FileReadResult } from "./FileReader";
import { logger } from "../../../shared/logger";
import PDFParser from "pdf2json";

/**
 * Reader for PDF files
 */
export class PdfReader extends FileReader {
  constructor() {
    super([".pdf"]);
  }

  getName(): string {
    return "PdfReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      logger.debug(`Reading PDF file: ${filePath}`);

      const content = await this.readPdfPages(filePath);

      return {
        // TODO: How to return pages? chunks? joined?
        content: content.join("\n\n"),
        metadata: {
          type: "pdf",
          fileName: filePath,
          status: "not_implemented",
        },
      };
    } catch (error) {
      logger.error(`Failed to read PDF file ${filePath}: ${error}`);
      throw new Error(`Failed to read PDF file: ${error}`);
    }
  }

  private readPdfPages(filePath: string): Promise<string[]> {
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
        resolve(pages);
      });

      pdfParser.loadPDF(filePath);
    });
  }
}
