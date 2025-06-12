import { FileReader, FileReadResult } from "./FileReader";
import { logger } from "../../../shared/logger";
import path from "path";
import * as officeParser from "officeparser";
import fs from "fs/promises";

/**
 * Reader for Microsoft Office documents using officeparser
 * 
 * Supported formats: .docx, .pptx, .xlsx, .odt, .odp, .ods
 * 
 * NOTE: This implementation only extracts text content. 
 * Images and rich metadata are not supported by the underlying officeparser library.
 * 
 * npm install officeparser
 */
export class OfficeReader extends FileReader {
  constructor() {
    super([".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"]);
  }

  getName(): string {
    return "OfficeReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      logger.debug(`Reading Office file: ${filePath}`);

      // Get file stats for basic metadata
      const stats = await fs.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();

      // Configure officeparser
      const config = {
        newlineDelimiter: "\n",
        ignoreNotes: false, // Include notes in parsed text
        outputErrorToConsole: false
      };

      // Extract text content using officeparser
      const content = await officeParser.parseOfficeAsync(filePath, config);

      // Build metadata object
      const metadata = {
        type: this.getDocumentType(ext),
        description: this.matchExtensionToDescription(ext),
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        accessedAt: stats.atime.toISOString(),
        extension: ext,
        status: "success",
        // Note: officeparser doesn't provide document metadata like author, title, etc.
        // These would need to be extracted using format-specific libraries
        extractedTextLength: content.length,
        hasContent: content.trim().length > 0
      };

      logger.debug(`Successfully extracted ${content.length} characters from ${filePath}`);

      return {
        content: content,
        // images: undefined, // officeparser doesn't extract images
        metadata: metadata
      };

    } catch (error: any) {
      logger.error(`Failed to read Office file ${filePath}: ${error.message}`);
      
      // Return error result instead of throwing
      return {
        content: "",
        metadata: {
          type: this.getDocumentType(path.extname(filePath).toLowerCase()),
          description: this.matchExtensionToDescription(path.extname(filePath)),
          fileName: path.basename(filePath),
          filePath: filePath,
          status: "error",
          error: error.message,
          errorType: error.name
        }
      };
    }
  }

  private getDocumentType(ext: string): string {
    const types: { [key: string]: string } = {
      ".docx": "word_document",
      ".doc": "word_document_legacy", 
      ".pptx": "powerpoint_presentation",
      ".ppt": "powerpoint_presentation_legacy",
      ".xlsx": "excel_spreadsheet",
      ".xls": "excel_spreadsheet_legacy", 
      ".odt": "openoffice_text",
      ".odp": "openoffice_presentation",
      ".ods": "openoffice_spreadsheet"
    };
    return types[ext] || "unknown_office_document";
  }

  private matchExtensionToDescription(ext: string): string {
    const descriptions: { [key: string]: string } = {
      ".docx": "Microsoft Word Document",
      ".doc": "Microsoft Word 2003 Document",
      ".pptx": "Microsoft PowerPoint Presentation", 
      ".ppt": "Microsoft PowerPoint 2003 Presentation",
      ".xlsx": "Microsoft Excel Spreadsheet",
      ".xls": "Microsoft Excel 2003 Spreadsheet",
      ".odt": "OpenDocument Text Document",
      ".odp": "OpenDocument Presentation",
      ".ods": "OpenDocument Spreadsheet"
    };
    return descriptions[ext] || "Unknown Office Document";
  }
}

/**
 * Configuration interface for officeparser
 */
export interface OfficeParserConfig {
  newlineDelimiter?: string;
  ignoreNotes?: boolean;
  outputErrorToConsole?: boolean;
}