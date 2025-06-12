import * as path from 'path';
import { PromptTemplateEngine, TemplateContext } from './PromptTemplateEngine';
import { logger } from '../../../shared/logger';

export interface PromptContext {
  input: string;
  filter: string;
  fileName: string;
  fileContent: string;
  chunkContent: string;
  chunkIndex?: number;
  totalChunks?: number;
  retrievedContext?: any;
}

/**
 * Manages prompt templates using Handlebars templating
 */
export class PromptManager {
  private templateEngine: PromptTemplateEngine;
  private systemPromptVersion: string = 'v4';
  private customSystemPrompt?: string;
  private templatesDir: string;

  constructor(templatesDir?: string) {
    this.templateEngine = new PromptTemplateEngine();
    this.templatesDir = templatesDir || path.join(__dirname, 'templates');
    this.initializeTemplates();
  }

  /**
   * Initialize templates and partials
   */
  private async initializeTemplates(): Promise<void> {
    try {
      const partialsDir = path.join(this.templatesDir, 'partials');
      await this.templateEngine.registerPartials(partialsDir);
      logger.info('Prompt templates initialized');
    } catch (error) {
      logger.error(`Failed to initialize templates: ${error}`);
    }
  }

  /**
   * Set a custom system prompt
   */
  setCustomSystemPrompt(prompt: string): void {
    this.customSystemPrompt = prompt;
    logger.info('Using custom system prompt');
  }

  /**
   * Get the system prompt
   */
  async getSystemPrompt(input: string, filter: string, description?: string): Promise<string> {
    if (this.customSystemPrompt) {
      return this.customSystemPrompt;
    }

    try {
      const templatePath = path.join(
        this.templatesDir,
        this.systemPromptVersion,
        'system.hbs'
      );

      const context: TemplateContext = {
        inputDirectory: input,
        filter: filter,
        userDescription: description,
      };

      // Enhance context with computed properties (like directory tree)
      const enhancedContext = await this.templateEngine.enhanceContext(context);

      return await this.templateEngine.renderFile(templatePath, enhancedContext);
    } catch (error) {
      logger.error(`Failed to render system prompt: ${error}`);
      // Fallback to a basic prompt
      return this.getFallbackSystemPrompt(input, filter);
    }
  }

  /**
   * Get the user prompt for a file
   */
  async getUserPrompt(context: PromptContext): Promise<string> {
    try {
      const templatePath = path.join(
        this.templatesDir,
        this.systemPromptVersion,
        'user.hbs'
      );

      const templateContext: TemplateContext = {
        fileName: context.fileName,
        filePath: context.fileName,
        fileContent: context.fileContent,
        chunkIndex: context.chunkIndex,
        totalChunks: context.totalChunks,
        chunkContent: context.chunkContent,
        inputDirectory: context.input,
        filter: context.filter
      };

      // Add retrieved context if available
      if (context.retrievedContext) {
        templateContext.retrievedEntities = context.retrievedContext.entities;
        templateContext.retrievedObservations = context.retrievedContext.observations;
      }

      // Enhance context
      const enhancedContext = await this.templateEngine.enhanceContext(templateContext);

      return await this.templateEngine.renderFile(templatePath, enhancedContext);
    } catch (error) {
      logger.error(`Failed to render user prompt: ${error}`);
      // Fallback to basic prompt
      return this.getFallbackUserPrompt(context);
    }
  }

  /**
   * Set the system prompt version
   */
  setSystemPromptVersion(version: string): void {
    this.systemPromptVersion = version;
    logger.info(`Using system prompt version: ${version}`);
  }

  /**
   * Get a fallback system prompt if template rendering fails
   */
  private getFallbackSystemPrompt(input: string, filter: string): string {
    return `You are an AI assistant designed to analyze code and documentation to extract knowledge in the form of a graph. 
    
    Your task is to identify entities (key concepts, functions, classes, modules, etc.) and their relationships from the given content.
    
    The input directory is: ${input}
    The file filter is: ${filter}
    
    Return a JSON object with:
    - entities: Array of objects with name, entityType, and observations
    - relations: Array of objects with from, to, and relationType`;
  }

  /**
   * Get a fallback user prompt if template rendering fails
   */
  private getFallbackUserPrompt(context: PromptContext): string {
    let prompt = `Analyze the following content from ${context.fileName}:\n\n`;
    
    if (context.chunkIndex && context.totalChunks && context.totalChunks > 1) {
      prompt += `(Chunk ${context.chunkIndex} of ${context.totalChunks})\n\n`;
    }

    prompt += `${context.chunkContent || context.fileContent}\n\n`;
    prompt += `Extract all entities and relationships from this content.`;

    return prompt;
  }

  /**
   * Render a custom template with context
   */
  async renderCustomTemplate(templateString: string, context: TemplateContext): Promise<string> {
    try {
      const template = this.templateEngine.compile(templateString);
      const enhancedContext = await this.templateEngine.enhanceContext(context);
      return this.templateEngine.render(template, enhancedContext);
    } catch (error) {
      logger.error(`Failed to render custom template: ${error}`);
      throw error;
    }
  }
}