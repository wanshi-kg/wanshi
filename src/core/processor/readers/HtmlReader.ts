import * as fs from 'fs';
import * as path from 'path';
import { FileReader, FileReadResult, ImageResult } from './FileReader';
import { HtmlToTextOptions } from 'html-to-text';
import { Logger } from '../../../shared';
import { TextChunker } from '../chunking';
import languageEncoding from "detect-file-encoding-and-language";
import { Iconv } from 'iconv';
import { extractHtmlLinks, RawReferences } from './referenceExtraction';

/**
 * Features:
 * - Smart content extraction (separates main content from navigation/ads)
 * - Document outline generation with heading hierarchy
 * - Metadata extraction (title, description, keywords, etc.)
 * - Image extraction with alt text and captions
 * - Link analysis and extraction
 * - Text formatting preservation where appropriate
 * 
 * Supported formats: .html, .htm, .xhtml
 */
export class HtmlReader extends FileReader {
  constructor(
    chunker: TextChunker,
    logger: Logger,
    private readonly extractLinks: boolean = false
  ) {
    super(['.html', '.htm', '.xhtml', '.php'], chunker, logger);
  }

  getName(): string {
    return 'HtmlReader';
  }

  async read(filePath: string): Promise<FileReadResult> {
    await this.validateFile(filePath);
    
    try {
      this.logger.debug(`Extracting content from HTML file: ${filePath}`);
      
      const startTime = Date.now();
      const encoding = await languageEncoding(filePath);
      const conv = new Iconv(encoding.encoding || 'utf-8', 'utf-8');
      const rawBuffer = await fs.promises.readFile(filePath);
      const rawHtml = conv.convert(rawBuffer).toString('utf-8');
      const stats = await fs.promises.stat(filePath);
      
      // Parse with multiple approaches for comprehensive extraction
      const cheerioResult = await this.parseWithCheerio(rawHtml);
      const htmlToTextResult = await this.parseWithHtmlToText(rawHtml);
      
      const content = htmlToTextResult.cleanText || htmlToTextResult.text;

      // Extract images
      const images = this.extractImages(cheerioResult.$ || null);
      
      const processingTime = Date.now() - startTime;
      
      // Build comprehensive metadata
      const metadata = {
        type: 'html_document',
        fileName: path.basename(filePath),
        filePath: filePath,
        fileSize: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        extension: path.extname(filePath).toLowerCase(),
        encoding: 'utf-8',
        
        // Document content analysis
        contentLength: content.length,
        htmlSize: rawHtml.length,
        processingTimeMs: processingTime,
        processorUsed: 'cheerio+unfluff+html-to-text',
        
        // HTML metadata
        title: cheerioResult.title || '',
        description: cheerioResult.description || '',
        keywords: cheerioResult.keywords || [],
        author: cheerioResult.author || cheerioResult.author || '',
        language: cheerioResult.language || 'en',
        
        // Content structure
        linkCount: cheerioResult.linkCount || 0,
        imageCount: images.length,
        paragraphCount: cheerioResult.paragraphCount || 0,
        
        // Content quality indicators
        wordCount: this.countWords(content),
        readingTime: this.estimateReadingTime(content),
        
        // Advanced metadata
        socialMedia: {},
        structuredData: cheerioResult.structuredData || [],
        canonicalUrl: cheerioResult.canonicalUrl || '',
        favicon: cheerioResult.favicon || '',
        
        // Content classification
        hasMainContent: !!htmlToTextResult.text && htmlToTextResult.text.length > 100,
        contentType: this.classifyContent(cheerioResult.$),

        status: 'success'
      };

      // Phase 0 reference extraction (network-free), gated by config.
      if (this.extractLinks) {
        const links = extractHtmlLinks(rawHtml);
        if (links.length) {
          const references: RawReferences = { internalLinks: links };
          (metadata as Record<string, any>).references = references;
        }
      }

      this.logger.debug(`Successfully processed HTML file ${filePath} in ${processingTime}ms`);

      return {
        chunks: [
          {
            content: content,
            index: 1,
            totalChunks: 1,
            startOffset: 0,
            endOffset: content.length,
            images: images.length > 0 ? images : undefined,
          },
        ],
        metadata: metadata
      };

    } catch (error: any) {
      this.logger.error(`Failed to read HTML file ${filePath}: ${error.message}`);
      
      return {
        chunks: [
          {
            content: '',
            index: 1,
            totalChunks: 1,
            startOffset: 0,
            endOffset: 0,
          },
        ],
        metadata: {
          type: 'html_document',
          description: 'HTML Document',
          fileName: path.basename(filePath),
          filePath: filePath,
          status: 'error',
          error: error.message,
          errorType: error.name,
          processorUsed: 'html_reader_legacy'
        }
      };
    }
  }

  /**
   * Parse HTML using Cheerio for fast DOM manipulation and metadata extraction
   */
  private async parseWithCheerio(html: string): Promise<CheerioResult> {
    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(html);

      // Extract basic metadata
      const title = $('title').first().text().trim() || 
                   $('meta[property="og:title"]').attr('content') || 
                   $('h1').first().text().trim();
                   
      const description = $('meta[name="description"]').attr('content') ||
                         $('meta[property="og:description"]').attr('content') ||
                         $('meta[name="twitter:description"]').attr('content') || '';

      const keywords = ($('meta[name="keywords"]').attr('content') || '')
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

      const author = $('meta[name="author"]').attr('content') ||
                    $('meta[property="article:author"]').attr('content') || '';

      const language = $('html').attr('lang') || 
                      $('meta[http-equiv="content-language"]').attr('content') || 'en';

      // Content analysis
      const linkCount = $('a[href]').length;
      const paragraphCount = $('p').length;
      const imageCount = $('img').length;

      // Extract structured data
      const structuredData: any[] = [];
      $('script[type="application/ld+json"]').each((_, elem) => {
        try {
          const jsonData = JSON.parse($(elem).html() || '{}');
          structuredData.push(jsonData);
        } catch (e) {
          // Ignore malformed JSON-LD
        }
      });

      // Social media metadata
      const socialMedia = {
        ogTitle: $('meta[property="og:title"]').attr('content') || '',
        ogDescription: $('meta[property="og:description"]').attr('content') || '',
        ogImage: $('meta[property="og:image"]').attr('content') || '',
        ogUrl: $('meta[property="og:url"]').attr('content') || '',
        twitterCard: $('meta[name="twitter:card"]').attr('content') || '',
        twitterTitle: $('meta[name="twitter:title"]').attr('content') || '',
        twitterDescription: $('meta[name="twitter:description"]').attr('content') || '',
        twitterImage: $('meta[name="twitter:image"]').attr('content') || ''
      };

      const canonicalUrl = $('link[rel="canonical"]').attr('href') || '';
      const favicon = $('link[rel="icon"]').attr('href') || 
                     $('link[rel="shortcut icon"]').attr('href') || '';

      return {
        $,
        title,
        description,
        keywords,
        author,
        language,
        linkCount,
        paragraphCount,
        imageCount,
        structuredData,
        socialMedia,
        canonicalUrl,
        favicon
      };

    } catch (error: any) {
      this.logger.warn(`Cheerio parsing failed: ${error.message}`);
      return {
        title: '',
        description: '',
        keywords: [],
        author: '',
        language: 'en',
        linkCount: 0,
        paragraphCount: 0,
        imageCount: 0,
        structuredData: [],
        socialMedia: {},
        canonicalUrl: '',
        favicon: ''
      };
    }
  }

  /**
   * Parse HTML using html-to-text for clean text extraction
   */
  private async parseWithHtmlToText(html: string): Promise<HtmlToTextResult> {
    try {
      const { convert } = await import('html-to-text');

      const options: HtmlToTextOptions = {
        wordwrap: false,
        selectors: [
          // Preserve important structure
          { selector: 'h1', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
          { selector: 'h2', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
          { selector: 'h3', format: 'heading', options: { leadingLineBreaks: 2, trailingLineBreaks: 1 } },
          { selector: 'h4', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'h5', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'h6', format: 'heading', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'p', format: 'paragraph', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'br', format: 'lineBreak' },
          { selector: 'ul', format: 'unorderedList', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'ol', format: 'orderedList', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'li', format: 'listItem', options: { leadingLineBreaks: 1 } },
          { selector: 'blockquote', format: 'blockquote', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
          { selector: 'table', format: 'table' },
          // Remove unwanted elements
          { selector: 'script', format: 'skip' },
          { selector: 'style', format: 'skip' },
          { selector: 'nav', format: 'skip' },
          { selector: '.navigation', format: 'skip' },
          { selector: '.sidebar', format: 'skip' },
          { selector: '.footer', format: 'skip' },
          { selector: '.header', format: 'skip' },
          { selector: '.menu', format: 'skip' },
          { selector: '.advertisement', format: 'skip' },
          { selector: '.ads', format: 'skip' }
        ]
      };

      const text = convert(html, options);

      return {
        text: text.trim(),
        cleanText: this.cleanText(text)
      };

    } catch (error: any) {
      this.logger.warn(`html-to-text parsing failed: ${error.message}`);
      return {
        text: '',
        cleanText: ''
      };
    }
  }

  /**
   * Extract images with metadata
   */
  private extractImages($: any): ImageResult[] {
    // For this implementation, we're not extracting actual image data
    // In a real scenario, you'd fetch the images and convert to buffers
    // This is a placeholder that shows how to extract image metadata
    return [];
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Estimate reading time in minutes
   */
  private estimateReadingTime(text: string): number {
    const wordsPerMinute = 200; // Average reading speed
    const wordCount = this.countWords(text);
    return Math.ceil(wordCount / wordsPerMinute);
  }

  /**
   * Classify content type
   */
  private classifyContent($: any): string {
    if (!$) return 'unknown';

    if ($('article').length > 0) return 'article';
    if ($('nav').length > 2 || $('.navigation').length > 0) return 'navigation';
    if ($('form').length > 2) return 'form';
    if ($('table').length > 1) return 'data';
    if ($('img').length > 5) return 'gallery';
    
    return 'webpage';
  }

  /**
   * Clean extracted text
   */
  private cleanText(text: string): string {
    return text
      .replace(/\n{3,}/g, '\n\n') // Remove excessive line breaks
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/^\s+|\s+$/g, '') // Trim
      .replace(/\t/g, ' '); // Replace tabs with spaces
  }
}

/**
 * Interfaces for parsing results
 */
interface CheerioResult {
  $?: any;
  title: string;
  description: string;
  keywords: string[];
  author: string;
  language: string;
  linkCount: number;
  paragraphCount: number;
  imageCount: number;
  structuredData: any[];
  socialMedia: any;
  canonicalUrl: string;
  favicon: string;
}

interface HtmlToTextResult {
  text: string;
  cleanText: string;
}

/**
 * Configuration options for HTML processing
 */
export interface HtmlReaderConfig {
  extractImages?: boolean;
  preserveFormatting?: boolean;
  skipNavigation?: boolean;
  extractStructuredData?: boolean;
  includeMetadata?: boolean;
}