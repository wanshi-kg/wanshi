import { FileReader, FileReadResult } from "./FileReader";
import { logger } from "../../../shared/logger";
import path from "path";
import fs from "fs/promises";

/**
 * Comprehensive Office Document Reader
 * 
 * This implementation uses multiple specialized libraries to extract:
 * - Text content
 * - Images (as Buffer[])
 * - Rich metadata (author, creation date, etc.)
 * 
 * Required dependencies:
 * npm install mammoth xlsx pptx-parser jszip @types/jszip
 * 
 * Note: Some libraries may require additional setup for specific features
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

      const ext = path.extname(filePath).toLowerCase();
      const stats = await fs.stat(filePath);

      // Route to appropriate parser based on file extension
      switch (ext) {
        case ".docx":
          return await this.readDocx(filePath, stats);
        case ".xlsx":
          return await this.readXlsx(filePath, stats);
        case ".pptx":
          return await this.readPptx(filePath, stats);
        case ".odt":
        case ".odp":
        case ".ods":
          return await this.readOpenDocument(filePath, stats, ext);
        default:
          throw new Error(`Unsupported file extension: ${ext}`);
      }

    } catch (error: any) {
      logger.error(`Failed to read Office file ${filePath}: ${error.message}`);
      
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

  /**
   * Read DOCX files using mammoth library
   * Extracts text, images, and metadata
   */
  private async readDocx(filePath: string, stats: fs.Stats): Promise<FileReadResult> {
    const mammoth = await import("mammoth");
    const JSZip = await import("jszip");

    // Extract text and images using mammoth
    const result = await mammoth.extractRawText({ path: filePath });
    const imageResult = await mammoth.convert({ path: filePath });
    
    // Extract images from document
    const images: Buffer[] = [];
    try {
      const zip = new JSZip.default();
      const fileBuffer = await fs.readFile(filePath);
      const zipContents = await zip.loadAsync(fileBuffer);
      
      // Look for images in word/media/ folder
      const imagePromises: Promise<Buffer>[] = [];
      zipContents.folder("word/media")?.forEach((relativePath, file) => {
        if (!file.dir && this.isImageFile(relativePath)) {
          imagePromises.push(file.async("nodebuffer"));
        }
      });
      
      const extractedImages = await Promise.all(imagePromises);
      images.push(...extractedImages);
    } catch (imageError) {
      logger.warn(`Could not extract images from DOCX: ${imageError}`);
    }

    // Extract metadata from core.xml
    const metadata = await this.extractDocxMetadata(filePath, stats);

    return {
      content: result.value,
      images: images.length > 0 ? images : undefined,
      metadata: {
        ...metadata,
        extractedTextLength: result.value.length,
        imageCount: images.length,
        status: "success"
      }
    };
  }

  /**
   * Read XLSX files using xlsx library
   */
  private async readXlsx(filePath: string, stats: fs.Stats): Promise<FileReadResult> {
    const XLSX = await import("xlsx");
    
    const workbook = XLSX.readFile(filePath);
    let content = "";
    const worksheetData: any[] = [];

    // Extract text from all worksheets
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      const sheetText = XLSX.utils.sheet_to_txt(worksheet);
      content += `\n--- Sheet: ${sheetName} ---\n${sheetText}\n`;
      
      // Store structured data for metadata
      worksheetData.push({
        name: sheetName,
        data: XLSX.utils.sheet_to_json(worksheet, { header: 1 })
      });
    });

    const metadata = {
      type: "excel_spreadsheet",
      description: "Microsoft Excel Spreadsheet",
      fileName: path.basename(filePath),
      filePath: filePath,
      fileSize: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      extension: ".xlsx",
      sheetCount: workbook.SheetNames.length,
      sheetNames: workbook.SheetNames,
      worksheetData: worksheetData,
      extractedTextLength: content.length,
      status: "success"
    };

    return {
      content: content.trim(),
      metadata: metadata
    };
  }

  /**
   * Read PPTX files using custom parser
   */
  private async readPptx(filePath: string, stats: fs.Stats): Promise<FileReadResult> {
    const JSZip = await import("jszip");
    const xml2js = await import("xml2js");

    const fileBuffer = await fs.readFile(filePath);
    const zip = new JSZip.default();
    const zipContents = await zip.loadAsync(fileBuffer);
    
    let content = "";
    const images: Buffer[] = [];
    let slideCount = 0;

    // Extract text from slides
    try {
      const slidePromises: Promise<string>[] = [];
      
      zipContents.folder("ppt/slides")?.forEach((relativePath, file) => {
        if (relativePath.endsWith(".xml") && !file.dir) {
          slideCount++;
          slidePromises.push(
            file.async("text").then(async (slideXml) => {
              const parser = new xml2js.Parser();
              const result = await parser.parseStringPromise(slideXml);
              return this.extractTextFromPptxSlide(result);
            })
          );
        }
      });

      const slideTexts = await Promise.all(slidePromises);
      content = slideTexts.map((text, index) => 
        `\n--- Slide ${index + 1} ---\n${text}`
      ).join("\n");

    } catch (parseError) {
      logger.warn(`Could not parse PPTX slides: ${parseError}`);
    }

    // Extract images
    try {
      const imagePromises: Promise<Buffer>[] = [];
      zipContents.folder("ppt/media")?.forEach((relativePath, file) => {
        if (!file.dir && this.isImageFile(relativePath)) {
          imagePromises.push(file.async("nodebuffer"));
        }
      });
      
      const extractedImages = await Promise.all(imagePromises);
      images.push(...extractedImages);
    } catch (imageError) {
      logger.warn(`Could not extract images from PPTX: ${imageError}`);
    }

    const metadata = {
      type: "powerpoint_presentation",
      description: "Microsoft PowerPoint Presentation",
      fileName: path.basename(filePath),
      filePath: filePath,
      fileSize: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      extension: ".pptx",
      slideCount: slideCount,
      imageCount: images.length,
      extractedTextLength: content.length,
      status: "success"
    };

    return {
      content: content.trim(),
      images: images.length > 0 ? images : undefined,
      metadata: metadata
    };
  }

  /**
   * Read OpenDocument formats (.odt, .odp, .ods)
   */
  private async readOpenDocument(filePath: string, stats: fs.Stats, ext: string): Promise<FileReadResult> {
    const JSZip = await import("jszip");
    const xml2js = await import("xml2js");

    const fileBuffer = await fs.readFile(filePath);
    const zip = new JSZip.default();
    const zipContents = await zip.loadAsync(fileBuffer);
    
    let content = "";
    const images: Buffer[] = [];

    try {
      // Extract content from content.xml
      const contentFile = zipContents.file("content.xml");
      if (contentFile) {
        const contentXml = await contentFile.async("text");
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(contentXml);
        content = this.extractTextFromOpenDocument(result);
      }

      // Extract images from Pictures folder
      const imagePromises: Promise<Buffer>[] = [];
      zipContents.folder("Pictures")?.forEach((relativePath, file) => {
        if (!file.dir && this.isImageFile(relativePath)) {
          imagePromises.push(file.async("nodebuffer"));
        }
      });
      
      const extractedImages = await Promise.all(imagePromises);
      images.push(...extractedImages);

    } catch (parseError) {
      logger.warn(`Could not parse OpenDocument file: ${parseError}`);
    }

    const metadata = {
      type: this.getDocumentType(ext),
      description: this.matchExtensionToDescription(ext),
      fileName: path.basename(filePath),
      filePath: filePath,
      fileSize: stats.size,
      createdAt: stats.birthtime.toISOString(),
      modifiedAt: stats.mtime.toISOString(),
      extension: ext,
      imageCount: images.length,
      extractedTextLength: content.length,
      status: "success"
    };

    return {
      content: content.trim(),
      images: images.length > 0 ? images : undefined,
      metadata: metadata
    };
  }

  /**
   * Extract metadata from DOCX core.xml
   */
  private async extractDocxMetadata(filePath: string, stats: fs.Stats): Promise<any> {
    try {
      const JSZip = await import("jszip");
      const xml2js = await import("xml2js");

      const fileBuffer = await fs.readFile(filePath);
      const zip = new JSZip.default();
      const zipContents = await zip.loadAsync(fileBuffer);
      
      const coreFile = zipContents.file("docProps/core.xml");
      const appFile = zipContents.file("docProps/app.xml");
      
      const metadata: any = {
        type: "word_document",
        description: "Microsoft Word Document",
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        extension: ".docx"
      };

      if (coreFile) {
        const coreXml = await coreFile.async("text");
        const parser = new xml2js.Parser();
        const coreResult = await parser.parseStringPromise(coreXml);
        
        const props = coreResult["cp:coreProperties"];
        if (props) {
          metadata.title = props["dc:title"]?.[0] || "";
          metadata.creator = props["dc:creator"]?.[0] || "";
          metadata.subject = props["dc:subject"]?.[0] || "";
          metadata.description = props["dc:description"]?.[0] || "";
          metadata.keywords = props["cp:keywords"]?.[0] || "";
          metadata.category = props["cp:category"]?.[0] || "";
          metadata.created = props["dcterms:created"]?.[0]?._ || "";
          metadata.modified = props["dcterms:modified"]?.[0]?._ || "";
          metadata.lastModifiedBy = props["cp:lastModifiedBy"]?.[0] || "";
        }
      }

      if (appFile) {
        const appXml = await appFile.async("text");
        const parser = new xml2js.Parser();
        const appResult = await parser.parseStringPromise(appXml);
        
        const props = appResult["Properties"];
        if (props) {
          metadata.application = props["Application"]?.[0] || "";
          metadata.appVersion = props["AppVersion"]?.[0] || "";
          metadata.company = props["Company"]?.[0] || "";
          metadata.template = props["Template"]?.[0] || "";
          metadata.totalTime = props["TotalTime"]?.[0] || "";
          metadata.pages = parseInt(props["Pages"]?.[0] || "0");
          metadata.words = parseInt(props["Words"]?.[0] || "0");
          metadata.characters = parseInt(props["Characters"]?.[0] || "0");
        }
      }

      return metadata;
    } catch (error) {
      logger.warn(`Could not extract DOCX metadata: ${error}`);
      return {
        type: "word_document",
        description: "Microsoft Word Document",
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        extension: ".docx"
      };
    }
  }

  /**
   * Extract text from PowerPoint slide XML
   */
  private extractTextFromPptxSlide(slideData: any): string {
    let text = "";
    
    const extractFromNode = (node: any): void => {
      if (typeof node === "string") {
        text += node + " ";
      } else if (Array.isArray(node)) {
        node.forEach(extractFromNode);
      } else if (typeof node === "object" && node !== null) {
        // Look for text in t elements (text runs)
        if (node["a:t"]) {
          if (Array.isArray(node["a:t"])) {
            node["a:t"].forEach((t: any) => text += t + " ");
          } else {
            text += node["a:t"] + " ";
          }
        }
        
        // Recursively search all properties
        Object.values(node).forEach(extractFromNode);
      }
    };
    
    extractFromNode(slideData);
    return text.trim();
  }

  /**
   * Extract text from OpenDocument XML
   */
  private extractTextFromOpenDocument(documentData: any): string {
    let text = "";
    
    const extractFromNode = (node: any): void => {
      if (typeof node === "string") {
        text += node + " ";
      } else if (Array.isArray(node)) {
        node.forEach(extractFromNode);
      } else if (typeof node === "object" && node !== null) {
        Object.values(node).forEach(extractFromNode);
      }
    };
    
    extractFromNode(documentData);
    return text.trim();
  }

  /**
   * Check if a file is an image based on extension
   */
  private isImageFile(fileName: string): boolean {
    const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".svg", ".webp"];
    const ext = path.extname(fileName).toLowerCase();
    return imageExtensions.includes(ext);
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