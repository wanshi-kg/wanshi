import Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import { DirectoryTreeGenerator } from '../../../shared/utils/directoryTree';
import { DocumentOutlineGenerator } from '../../../shared/utils/documentOutline';
import { OutlineOptions } from '../../../types/ProcessingOptions';
import { Logger } from '../../../shared';

export interface TemplateContext {
  // File-specific context
  fileName?: string;
  fileContent?: string;
  fileOutline?: string;
  fileExtension?: string;
  filePath?: string;
  
  // Directory context
  inputDirectory?: string;
  filter?: string;
  directoryTree?: string;
  fileList?: string[];
  userDescription?: string;

  // Chunk context
  chunkIndex?: number;
  totalChunks?: number;
  chunkContent?: string;
  
  // Retrieved context
  retrievedEntities?: any[];
  retrievedObservations?: string[];
  
  // Custom context
  [key: string]: any;
}

/**
 * Template engine for managing prompt templates
 */
export class PromptTemplateEngine {
  private handlebars: typeof Handlebars;
  private templateCache: Map<string, HandlebarsTemplateDelegate>;
  private partialsRegistered: boolean = false;
  private logger: Logger;
  private outlineOptions?: OutlineOptions;

  constructor(logger: Logger, outlineOptions?: OutlineOptions) {
    this.logger = logger;
    this.outlineOptions = outlineOptions;
    this.handlebars = Handlebars.create();
    this.templateCache = new Map();
    this.registerHelpers();
  }

  /**
   * Register custom Handlebars helpers
   */
  private registerHelpers(): void {
    // Helper to check if a value exists
    this.handlebars.registerHelper('exists', (value: any) => {
      return value !== undefined && value !== null;
    });

    // Helper to join array with separator
    this.handlebars.registerHelper('join', (array: any[], separator: string = ', ') => {
      if (!Array.isArray(array)) return '';
      return array.join(separator);
    });

    // Helper to truncate text
    this.handlebars.registerHelper('truncate', (text: string, length: number = 100) => {
      if (!text || text.length <= length) return text;
      return text.substring(0, length) + '...';
    });

    // Helper to format file size
    this.handlebars.registerHelper('fileSize', (bytes: number) => {
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      if (bytes === 0) return '0 Byte';
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    });

    // Helper for conditional rendering. Must be a regular `function` (not an
    // arrow): Handlebars binds `this` to the current template context when it
    // invokes a block helper, and the body must render with that context. As an
    // arrow, `this` was the engine instance, so the block rendered with no data
    // — e.g. "Chunk  of  from " (KG-16).
    this.handlebars.registerHelper('when', function (this: any, value1: any, operator: string, value2: any, options: any) {
      switch (operator) {
        case '==': return value1 == value2 ? options.fn(this) : options.inverse(this);
        case '===': return value1 === value2 ? options.fn(this) : options.inverse(this);
        case '!=': return value1 != value2 ? options.fn(this) : options.inverse(this);
        case '!==': return value1 !== value2 ? options.fn(this) : options.inverse(this);
        case '<': return value1 < value2 ? options.fn(this) : options.inverse(this);
        case '<=': return value1 <= value2 ? options.fn(this) : options.inverse(this);
        case '>': return value1 > value2 ? options.fn(this) : options.inverse(this);
        case '>=': return value1 >= value2 ? options.fn(this) : options.inverse(this);
        case '&&': return value1 && value2 ? options.fn(this) : options.inverse(this);
        case '||': return value1 || value2 ? options.fn(this) : options.inverse(this);
        default: throw new Error(`Unknown operator: ${operator}`);
      }
    });

    // // Helper to generate directory tree
    // this.handlebars.registerHelper('directoryTree', async (dirPath: string, filter: string) => {
    //   try {
    //     const tree = await DirectoryTreeGenerator.generateTextTree(dirPath, {
    //       filter,
    //       excludePatterns: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
    //       maxDepth: 5
    //     });
    //     return new this.handlebars.SafeString(tree);
    //   } catch (error) {
    //     logger.error(`Failed to generate directory tree: ${error}`);
    //     return '[Directory tree generation failed]';
    //   }
    // });
  }

  /**
   * Register template partials from a directory
   */
  async registerPartials(partialsDir: string): Promise<void> {
    if (this.partialsRegistered) return;

    try {
      const files = await fs.promises.readdir(partialsDir);
      
      for (const file of files) {
        if (file.endsWith('.hbs') || file.endsWith('.handlebars')) {
          const partialName = path.basename(file, path.extname(file));
          const partialPath = path.join(partialsDir, file);
          const partialContent = await fs.promises.readFile(partialPath, 'utf-8');
          
          this.handlebars.registerPartial(partialName, partialContent);
          this.logger.debug(`Registered partial: ${partialName}`);
        }
      }
      
      this.partialsRegistered = true;
    } catch (error) {
      this.logger.error(`Failed to register partials: ${error}`);
    }
  }

  /**
   * Compile a template from string
   */
  compile(templateString: string): HandlebarsTemplateDelegate {
    return this.handlebars.compile(templateString, { noEscape: true });
  }

  /**
   * Compile a template from file
   */
  async compileFile(templatePath: string): Promise<HandlebarsTemplateDelegate> {
    // Check cache first
    if (this.templateCache.has(templatePath)) {
      return this.templateCache.get(templatePath)!;
    }

    try {
      const templateContent = await fs.promises.readFile(templatePath, 'utf-8');
      const compiled = this.compile(templateContent);
      
      // Cache the compiled template
      this.templateCache.set(templatePath, compiled);
      
      return compiled;
    } catch (error) {
      throw new Error(`Failed to compile template ${templatePath}: ${error}`);
    }
  }

  /**
   * Render a template with context
   */
  render(template: HandlebarsTemplateDelegate, context: TemplateContext): string {
    return template(context);
  }

  /**
   * Render a template file with context
   */
  async renderFile(templatePath: string, context: TemplateContext): Promise<string> {
    const template = await this.compileFile(templatePath);
    return this.render(template, context);
  }

  /**
   * Enhance context with additional computed properties
   */
  async enhanceContext(context: TemplateContext): Promise<TemplateContext> {
    const enhanced = { ...context };

    // Generate directory tree if needed
    if (enhanced.inputDirectory && enhanced.filter && !enhanced.directoryTree) {
      try {
        enhanced.directoryTree = await DirectoryTreeGenerator.generateTextTree(
          enhanced.inputDirectory,
          {
            filter: enhanced.filter,
            excludePatterns: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
            maxDepth: 5
          },
          this.logger
        );
      } catch (error) {
        this.logger.error(`Failed to generate directory tree: ${error}`);
      }
    }

    // Add file list if needed
    if (enhanced.inputDirectory && enhanced.filter && !enhanced.fileList) {
      try {
        enhanced.fileList = await DirectoryTreeGenerator.getFilteredFiles(
          enhanced.inputDirectory,
          enhanced.filter,
          ['node_modules/**', '.git/**', 'dist/**', 'build/**']
        );
      } catch (error) {
        this.logger.error(`Failed to get file list: ${error}`);
      }
    }

    // Extract file extension
    if (enhanced.fileName && !enhanced.fileExtension) {
      enhanced.fileExtension = path.extname(enhanced.fileName).toLowerCase();
    }

    // Extract document outline (skip entirely when disabled via config)
    if (
      this.outlineOptions?.enabled !== false &&
      enhanced.fileContent &&
      enhanced.fileExtension
    ) {
      try {
        enhanced.fileOutline = await DocumentOutlineGenerator.generateOutlineFromContent(
          enhanced.fileContent,
          enhanced.fileExtension.slice(1),
          {
            maxDepth: this.outlineOptions?.maxDepth,
            includeLineNumbers: this.outlineOptions?.includeLineNumbers,
            includePrivate: this.outlineOptions?.includePrivate,
            includeComments: this.outlineOptions?.includeComments,
            compact: this.outlineOptions?.compact,
          }
        );
      } catch (error: any) {
        this.logger.warn(`Cannot generate document outline from file content: ${error.message}`);
      }
    }

    return enhanced;
  }

  /**
   * Clear template cache
   */
  clearCache(): void {
    this.templateCache.clear();
  }
}