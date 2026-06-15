import { FileReader, FileReadResult, ImageResult } from "./FileReader";
import path from "path";
import fs from "fs/promises";
import { spawn, SpawnOptions } from "child_process";
import { promisify } from "util";
import { Logger } from "../../../shared";
import { TextChunker } from "../chunking";

/**
 * Installation:
 * pip install docling
 *
 * Supported formats: .pdf, .docx, .xlsx, .pptx, .html, .md, .txt,
 *                    .png, .jpg, .jpeg, .bmp, .tiff
 */
export class DoclingReader extends FileReader {
  private pythonExecutable: string;
  private maxFileSize: number;
  private maxPages: number;
  private tempDir: string;

  constructor(
    pythonExecutable = "python3",
    maxFileSize = 100 * 1024 * 1024, // 100MB
    maxPages = 1000,
    tempDir = "./temp",
    chunker: TextChunker,
    logger: Logger,
    // When used as the `pdfEngine`, pass `[".pdf"]` so Docling claims only PDFs
    // (office/markdown/etc. stay with their dedicated readers). Defaults to the
    // full Docling format set for the standalone "docling for everything" use.
    extensions?: string[]
  ) {
    super(
      extensions ?? [
        // Document formats
        ".pdf",
        ".docx",
        ".xlsx",
        ".pptx",
        ".odt",
        ".odp",
        ".ods",
        // Web formats
        ".html",
        ".htm",
        ".md",
        ".txt",
        ".rtf",
        // Image formats (with OCR)
        ".png",
        ".jpg",
        ".jpeg",
        ".bmp",
        ".tiff",
        ".gif",
        ".webp",
      ],
      chunker,
      logger
    );

    this.pythonExecutable = pythonExecutable;
    this.maxFileSize = maxFileSize;
    this.maxPages = maxPages;
    this.tempDir = tempDir;
    this.ensureTempDir();
  }

  getName(): string {
    return "DoclingReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      this.logger.debug(`Processing document with Docling: ${filePath}`);

      const stats = await fs.stat(filePath);

      // Validate file size
      if (stats.size > this.maxFileSize) {
        throw new Error(
          `File size ${stats.size} exceeds maximum allowed size ${this.maxFileSize}`
        );
      }

      // Process document with Docling
      const startTime = Date.now();
      const doclingResult = await this.processWithDocling(filePath);
      const processingTime = Date.now() - startTime;

      // Extract images if present
      const images = await this.extractImages(doclingResult);

      // Build comprehensive metadata
      const metadata = {
        type: this.getDocumentType(path.extname(filePath).toLowerCase()),
        description: this.getDocumentDescription(path.extname(filePath)),
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        extension: path.extname(filePath).toLowerCase(),

        // Docling-specific metadata
        ...doclingResult.metadata,

        // Processing metadata
        processingTimeMs: processingTime,
        processorUsed: "docling",
        doclingVersion: doclingResult.version || "unknown",
        contentLength: doclingResult.content.length,
        hasImages: images.length > 0,
        imageCount: images.length,
        status: "success",
      };

      this.logger.debug(
        `Successfully processed ${filePath} with Docling in ${processingTime}ms`
      );

      return {
        chunks: [
          {
            content: doclingResult.content,
            startOffset: 0,
            endOffset: doclingResult.content.length,
            index: 1,
            totalChunks: 1,
            images: images.length > 0 ? images : undefined,
          },
        ],
        metadata: metadata,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to process document with Docling ${filePath}: ${error.message}`
      );

      return {
        chunks: [],
        metadata: {
          type: this.getDocumentType(path.extname(filePath).toLowerCase()),
          description: this.getDocumentDescription(path.extname(filePath)),
          fileName: path.basename(filePath),
          filePath: filePath,
          status: "error",
          error: error.message,
          errorType: error.name,
          processorUsed: "docling",
          processingStep: error.step || "unknown",
        },
      };
    }
  }

  /**
   * Process document using Docling CLI
   */
  private async processWithDocling(
    filePath: string
  ): Promise<DoclingProcessResult> {
    const outputPath = path.join(
      this.tempDir,
      `docling_output_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 11)}.json`
    );

    try {
      // Build Docling command
      this.pythonExecutable = "docling";
      const doclingArgs = [
        // "-m",
        // "docling.cli.main", // Use CLI module
        filePath, // Input file
        "--to",
        "json", // Output as JSON for structured parsing
        "--output",
        outputPath, // Output file
        // "--max-pages",
        // this.maxPages.toString(),
        // "--max-file-size",
        // this.maxFileSize.toString(),
      ];

      this.logger.debug(
        `Running Docling: ${this.pythonExecutable} ${doclingArgs.join(" ")}`
      );

      // Execute Docling
      const result = await this.executeCommand(
        this.pythonExecutable,
        doclingArgs
      );

      if (result.code !== 0) {
        throw new Error(`Docling processing failed: ${result.stderr}`);
      }

      // Read the output JSON
      const outputContent = await fs.readFile(outputPath, "utf-8");
      const doclingOutput = JSON.parse(outputContent);

      // Extract content and metadata
      const processedResult = this.parseDoclingOutput(
        doclingOutput,
        result.stdout
      );

      fs.writeFile("debug_output_text.txt", processedResult.content);

      // Cleanup
      await this.cleanup(outputPath);

      return processedResult;
    } catch (error: any) {
      error.step = "docling_processing";

      // Cleanup on error
      try {
        await this.cleanup(outputPath);
      } catch (cleanupError) {
        this.logger.warn(`Failed to cleanup temp file: ${cleanupError}`);
      }

      throw error;
    }
  }

  /**
   * Parse Docling JSON output into our format
   */
  private parseDoclingOutput(
    doclingJson: any,
    stdout: string
  ): DoclingProcessResult {
    try {
      // Extract main content (Markdown format is usually the most readable)
      let content = "";

      if (doclingJson.main_text) {
        content = doclingJson.main_text;
      } else if (doclingJson.markdown) {
        content = doclingJson.markdown;
      } else if (doclingJson.text) {
        content = doclingJson.text;
      } else if (doclingJson.content) {
        content = doclingJson.content;
      }

      // Extract document metadata
      const metadata: any = {
        // Document structure
        pageCount: doclingJson.page_count || doclingJson.pages?.length || 0,
        elementCount: doclingJson.elements?.length || 0,

        // Content analysis
        hastables: doclingJson.tables?.length > 0 || false,
        tableCount: doclingJson.tables?.length || 0,
        hasFigures: doclingJson.figures?.length > 0 || false,
        figureCount: doclingJson.figures?.length || 0,
        hasFormulas: doclingJson.formulas?.length > 0 || false,
        formulaCount: doclingJson.formulas?.length || 0,

        // Document properties
        title: doclingJson.title || doclingJson.metadata?.title || "",
        author: doclingJson.author || doclingJson.metadata?.author || "",
        subject: doclingJson.subject || doclingJson.metadata?.subject || "",
        creator: doclingJson.creator || doclingJson.metadata?.creator || "",
        producer: doclingJson.producer || doclingJson.metadata?.producer || "",
        creationDate:
          doclingJson.creation_date ||
          doclingJson.metadata?.creation_date ||
          "",
        modificationDate:
          doclingJson.modification_date ||
          doclingJson.metadata?.modification_date ||
          "",

        // Language and classification
        detectedLanguage: doclingJson.language || "unknown",
        confidence: doclingJson.confidence || null,

        // Processing details
        processingModel: doclingJson.model_info || "docling_default",
        layoutAnalysis: doclingJson.layout_analysis || {},
        tableStructure: doclingJson.table_structure || {},

        // Raw Docling output for advanced use cases
        rawDoclingOutput: doclingJson,
      };

      // Extract images information
      const images = doclingJson.images || doclingJson.figures || [];
      if (images.length > 0) {
        metadata.imageMetadata = images.map((img: any) => ({
          id: img.id || img.name,
          caption: img.caption || img.alt_text || "",
          bbox: img.bbox || img.bounding_box,
          confidence: img.confidence,
          classification: img.classification || img.type,
        }));
      }

      // Extract table information
      const tables = doclingJson.tables || [];
      if (tables.length > 0) {
        metadata.tableMetadata = tables.map((table: any) => ({
          id: table.id,
          caption: table.caption || "",
          rowCount: table.row_count || table.rows?.length || 0,
          columnCount: table.column_count || table.columns?.length || 0,
          bbox: table.bbox || table.bounding_box,
          confidence: table.confidence,
        }));
      }

      return {
        content: content.trim(),
        metadata: metadata,
        version: this.extractVersionFromOutput(stdout),
        images: images,
      };
    } catch (parseError: any) {
      throw new Error(`Failed to parse Docling output: ${parseError.message}`);
    }
  }

  /**
   * Extract embedded images from Docling output
   */
  private async extractImages(
    doclingResult: DoclingProcessResult
  ): Promise<ImageResult[]> {
    const images: ImageResult[] = [];

    try {
      if (doclingResult.images && Array.isArray(doclingResult.images)) {
        for (const imageInfo of doclingResult.images) {
          if (imageInfo.data) {
            // If image data is base64 encoded
            if (
              typeof imageInfo.data === "string" &&
              imageInfo.data.startsWith("data:")
            ) {
              const base64Data = imageInfo.data.split(",")[1];
              const buffer = Buffer.from(base64Data, "base64");
              images.push({ buffer: buffer });
            } else if (
              imageInfo.path &&
              (await this.fileExists(imageInfo.path))
            ) {
              // If image is saved as a separate file
              const buffer = await fs.readFile(imageInfo.path);
              images.push({ buffer });
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not extract images from Docling output: ${error}`
      );
    }

    return images;
  }

  /**
   * Execute command and return result
   */
  private async executeCommand(
    command: string,
    args: string[]
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const options: SpawnOptions = {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      };

      const child = spawn(command, args, options);

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        resolve({
          code: code || 0,
          stdout,
          stderr,
        });
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to execute command: ${error.message}`));
      });

      // Set timeout for long-running processes
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Command execution timeout"));
      }, 300000); // 5 minutes timeout

      child.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Extract Docling version from output
   */
  private extractVersionFromOutput(output: string): string {
    const versionMatch = output.match(/docling[^\d]*(\d+\.\d+\.\d+)/i);
    return versionMatch ? versionMatch[1] : "unknown";
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanup(filePath: string): Promise<void> {
    try {
      if (await this.fileExists(filePath)) {
        await fs.unlink(filePath);
        this.logger.debug(`Cleaned up temporary file: ${filePath}`);
      }
    } catch (error) {
      this.logger.warn(
        `Could not clean up temporary file ${filePath}: ${error}`
      );
    }
  }

  /**
   * Ensure temp directory exists
   */
  private async ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      this.logger.warn(
        `Could not create temp directory ${this.tempDir}: ${error}`
      );
    }
  }

  /**
   * Get document type based on extension
   */
  private getDocumentType(ext: string): string {
    const types: { [key: string]: string } = {
      ".pdf": "pdf_document",
      ".docx": "word_document",
      ".xlsx": "excel_spreadsheet",
      ".pptx": "powerpoint_presentation",
      ".html": "html_document",
      ".htm": "html_document",
      ".md": "markdown_document",
      ".txt": "text_document",
      ".rtf": "rtf_document",
      ".odt": "openoffice_text",
      ".odp": "openoffice_presentation",
      ".ods": "openoffice_spreadsheet",
      ".png": "image_document",
      ".jpg": "image_document",
      ".jpeg": "image_document",
      ".bmp": "image_document",
      ".tiff": "image_document",
      ".gif": "image_document",
      ".webp": "image_document",
    };
    return types[ext] || "unknown_document";
  }

  /**
   * Get human-readable description
   */
  private getDocumentDescription(ext: string): string {
    const descriptions: { [key: string]: string } = {
      ".pdf": "PDF Document",
      ".docx": "Microsoft Word Document",
      ".xlsx": "Microsoft Excel Spreadsheet",
      ".pptx": "Microsoft PowerPoint Presentation",
      ".html": "HTML Document",
      ".htm": "HTML Document",
      ".md": "Markdown Document",
      ".txt": "Text Document",
      ".rtf": "Rich Text Format Document",
      ".odt": "OpenDocument Text",
      ".odp": "OpenDocument Presentation",
      ".ods": "OpenDocument Spreadsheet",
      ".png": "PNG Image",
      ".jpg": "JPEG Image",
      ".jpeg": "JPEG Image",
      ".bmp": "Bitmap Image",
      ".tiff": "TIFF Image",
      ".gif": "GIF Image",
      ".webp": "WebP Image",
    };
    return descriptions[ext] || "Unknown Document";
  }
}

/**
 * Interfaces for Docling integration
 */
interface DoclingProcessResult {
  content: string;
  metadata: any;
  version?: string;
  images?: any[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Configuration for Docling processing
 */
export interface DoclingConfig {
  pythonExecutable?: string;
  maxFileSize?: number;
  maxPages?: number;
  tempDir?: string;
  outputFormat?: "json" | "markdown" | "html";
  enableOCR?: boolean;
  tableRecognition?: boolean;
  figureExtraction?: boolean;
}
