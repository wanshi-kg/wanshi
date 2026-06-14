import * as fs from "fs";
import { ChunkResult, FileReader, FileReadResult, ImageResult } from "./FileReader";
import { Logger } from "../../../shared";
import { ProcessedChunk } from "../../../types";
import { TextChunker } from "../chunking";
import { splitTrailingReferences } from "./stripReferences";
import {
  extractBareUrls,
  extractCitations,
  extractMarkdownLinks,
  RawReferences,
} from "./referenceExtraction";

/**
 * Represents markdown content with extracted images
 */
export interface MarkdownContent {
  text: string;
  images: ImageMetadata[];
}

/**
 * Metadata for images found in markdown content
 */
export interface ImageMetadata {
  alt?: string;
  url?: string;
  base64?: string;
  path?: string;
}

/**
 * Custom error for markdown reading failures
 */
export class MarkdownReadError extends Error {
  constructor(message: string, options?: any) {
    super(message);
    this.name = 'MarkdownReadError';
  }
}

/**
 * Reader for markdown text files with image extraction support
 */
export class MarkdownReader extends FileReader {
  constructor(
    chunker: TextChunker,
    logger: Logger,
    private readonly stripReferences: boolean = false,
    private readonly extractLinks: boolean = false,
    private readonly extractCites: boolean = false
  ) {
    super([".md", ".markdown"], chunker, logger);
  }

  getName(): string {
    return "MarkdownReader";
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);

    try {
      this.logger.debug(`Reading markdown file: ${filePath}`);

      const markdownContent = await MarkdownProcessor.processFile(filePath);
      const fullText = markdownContent.text; // pre-strip, for reference extraction

      // Detect the trailing bibliography once if either consumer needs it.
      const split =
        this.stripReferences || this.extractCites
          ? splitTrailingReferences(markdownContent.text)
          : undefined;
      if (this.stripReferences && split?.references) {
        this.logger.info(
          `Quarantined trailing references section of ${filePath} (${split.references.length} chars)`
        );
        markdownContent.text = split.body;
      }

      // Reference extraction, gated by config. Markdown `[t](u)`/`[[wiki]]` links
      // PLUS bare URLs (web-clip `> source:` headers etc.); external ones feed the
      // Phase-1 fetcher, internal ones the Phase-0 resolver.
      const references: RawReferences = {};
      if (this.extractLinks) {
        const seen = new Set<string>();
        const links = [...extractMarkdownLinks(fullText), ...extractBareUrls(fullText)].filter(
          (l) => (seen.has(l.target) ? false : (seen.add(l.target), true))
        );
        if (links.length) references.links = links;
      }
      if (this.extractCites) {
        const cites = extractCitations(split?.references, fullText);
        if (cites.length) references.citations = cites;
      }
      const hasRefs = !!(references.links || references.citations);

      const chunks = await this.chunker.chunk(markdownContent.text);

      const enrichedChunks = await this.enrichChunksWithImages(
        chunks, 
        markdownContent.images
      );

      this.logImageExtractionResults(markdownContent.images.length);

      return {
        chunks: enrichedChunks,
        metadata: {
          type: "text",
          encoding: "utf-8",
          size: markdownContent.text.length,
          imageCount: markdownContent.images.length,
          ...(hasRefs ? { references } : {}),
        },
      };
    } catch (error) {
      const errorMessage = `Failed to read markdown file ${filePath}: ${error}`;
      this.logger.error(errorMessage);
      throw new MarkdownReadError(errorMessage, { cause: error });
    }
  }

  private async enrichChunksWithImages(
    chunks: ProcessedChunk[],
    images: ImageMetadata[]
  ): Promise<ChunkResult[]> {
    return Promise.all(
      chunks.map(async (chunk) => {
        const imageReferences = this.extractImageReferences(chunk.content);
        const imageBuffers = await this.resolveImageBuffers(imageReferences, images);
        
        return {
          content: chunk.content,
          images: imageBuffers,
          startOffset: chunk.startOffset,
          endOffset: chunk.endOffset,
          index: chunk.index,
          totalChunks: chunk.totalChunks,
        };
      })
    );
  }

  private extractImageReferences(content: string): number[] {
    const imagePattern = /!\[.*?\]\((\d+)\)/g;
    const references: number[] = [];
    let match;

    while ((match = imagePattern.exec(content)) !== null) {
      const index = parseInt(match[1], 10);
      if (!isNaN(index)) {
        references.push(index);
      }
    }

    return references;
  }

  private async resolveImageBuffers(
    references: number[], 
    images: ImageMetadata[]
  ): Promise<ImageResult[]> {
    const results: ImageResult[] = [];
    
    for (const ref of references) {
      if (ref >= 0 && ref < images.length) {
        try {
          const buffer = await ImageBufferResolver.resolve(images[ref]);
          results.push({
            buffer: buffer,
            alt: images[ref].alt,
            path: images[ref].path || images[ref].url,
          });
        } catch (error) {
          this.logger.warn(`Failed to resolve image at index ${ref}: ${error}`);
          // Continue processing other images instead of failing completely
        }
      } else {
        this.logger.warn(`Invalid image reference: ${ref}`);
      }
    }

    return results;
  }

  private logImageExtractionResults(imageCount: number): void {
    if (imageCount > 0) {
      this.logger.debug(`Extracted ${imageCount} images from markdown content`);
    }
  }
}

/**
 * Handles processing of markdown files and image extraction
 */
export class MarkdownProcessor {
  private static readonly IMAGE_PATTERN = /!\[(.*?)\]\((.*?)\)/gim;

  public static async processFile(filePath: string): Promise<MarkdownContent> {
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      return this.extractImagesFromContent(content);
    } catch (error) {
      throw new MarkdownReadError(`Failed to process markdown file: ${filePath}`, { cause: error });
    }
  }

  public static extractImageMetadata(imageMarkdown: string): ImageMetadata {
    const matches = Array.from(imageMarkdown.matchAll(this.IMAGE_PATTERN));

    if (matches.length === 0) {
      throw new MarkdownReadError(`Invalid image markdown syntax: ${imageMarkdown}`);
    }

    const [, alt, source] = matches[0];
    return this.parseImageSource(alt, source);
  }

  private static parseImageSource(alt: string, source: string): ImageMetadata {
    if (source.startsWith("http://") || source.startsWith("https://")) {
      return { alt, url: source };
    }
    
    if (source.startsWith("data:image/")) {
      const base64Match = source.match(/^data:image\/[^;]+;base64,(.+)$/);
      if (base64Match) {
        return { alt, base64: base64Match[1] };
      }
    }
    
    // Assume it's a file path
    return { alt, path: source };
  }

  private static extractImagesFromContent(content: string): MarkdownContent {
    const images: ImageMetadata[] = [];
    
    const processedText = content.replace(this.IMAGE_PATTERN, (match, alt, source) => {
      try {
        const imageMetadata = this.parseImageSource(alt, source);
        images.push(imageMetadata);
        return `![${alt}](${images.length - 1})`;
      } catch (error) {
        // If we can't parse the image, leave it as-is
        return match;
      }
    });

    return {
      text: processedText,
      images,
    };
  }
}

/**
 * Handles resolving image metadata to actual buffer data
 */
export class ImageBufferResolver {
  public static async resolve(imageMetadata: ImageMetadata): Promise<Buffer> {
    if (imageMetadata.base64) {
      return this.resolveBase64(imageMetadata.base64);
    }
    
    if (imageMetadata.url) {
      return this.resolveUrl(imageMetadata.url);
    }
    
    if (imageMetadata.path) {
      return this.resolvePath(imageMetadata.path);
    }
    
    throw new MarkdownReadError(
      `No valid image source found for image: ${imageMetadata.alt || 'unknown'}`
    );
  }

  private static resolveBase64(base64Data: string): Buffer {
    try {
      return Buffer.from(base64Data, "base64");
    } catch (error) {
      throw new MarkdownReadError("Invalid base64 image data", { cause: error });
    }
  }

  private static async resolveUrl(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new MarkdownReadError(`Failed to fetch image from URL: ${url}`, { cause: error });
    }
  }

  private static async resolvePath(filePath: string): Promise<Buffer> {
    try {
      return await fs.promises.readFile(filePath);
    } catch (error) {
      throw new MarkdownReadError(`Failed to read image file: ${filePath}`, { cause: error });
    }
  }
}