import * as path from 'path';
import * as fs from 'fs';
import { PromptTemplateEngine, TemplateContext } from './PromptTemplateEngine';
import { Logger } from '../../../shared';
import { ClassificationResult, ContentClass, CorpusGlossary, OutlineOptions } from '../../../types';
import { NER_DOMAIN_EXAMPLES } from '../../processor/classifier/NER_DOMAIN_EXAMPLES';

export interface PromptContext {
  input: string;
  filter: string;
  fileName: string;
  fileContent: string;
  chunkContent: string;
  chunkIndex?: number;
  totalChunks?: number;
  retrievedContext?: any;
  contentClasses?: ClassificationResult[];
  /** Corpus-specific glossary from the pre-pass, injected as soft naming hints. */
  corpusGlossary?: CorpusGlossary;
}

/** Minimum confidence to inject domain hints (below this = generic extraction) */
const LOW_CONFIDENCE_THRESHOLD = 0.3;

/** If top-2 class confidences are within this delta, treat as mixed domain */
const MIXED_DOMAIN_THRESHOLD = 0.2;

/** Maps content class to its example partial filename */
const CLASS_TO_PARTIAL: Record<ContentClass, string> = {
  code:          'code.md',
  financial:     'financial.md',
  medical:       'medical.md',
  legal:         'legal.md',
  technical:     'logs.md',
  research:      'generic.md',
  transcript:    'transcript.md',
  tabular:       'tabular.md',
  communication: 'generic.md',
  documentation: 'generic.md',
  narrative:     'article.md',
  reference:     'notes.md',
};

/**
 * Manages prompt templates using Handlebars templating
 */
export class PromptManager {
  private templateEngine: PromptTemplateEngine;
  private systemPromptVersion: string = 'v4.5';
  private customSystemPrompt?: string;
  private templatesDir: string;
  private logger: Logger;

  /** Cache of loaded domain example partial contents keyed by filename */
  private domainPartialCache: Map<string, string> = new Map();

  constructor(logger: Logger, templatesDir?: string, outlineOptions?: OutlineOptions) {
    this.logger = logger;
    this.templateEngine = new PromptTemplateEngine(logger, outlineOptions);
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
      this.logger.info('Prompt templates initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize templates: ${error}`);
    }
  }

  /**
   * Override the prompt template version (default: 'v4.5').
   * Must match a directory under src/core/llm/prompts/templates/.
   */
  setPromptVersion(version: string): void {
    this.systemPromptVersion = version;
    this.logger.info(`Using prompt version: ${version}`);
  }

  /**
   * Set a custom system prompt
   */
  setCustomSystemPrompt(prompt: string): void {
    this.customSystemPrompt = prompt;
    this.logger.info('Using custom system prompt');
  }

  /**
   * Get the system prompt, optionally enriched with domain-specific examples
   */
  async getSystemPrompt(
    input: string,
    filter: string,
    description?: string,
    contentClasses?: ClassificationResult[]
  ): Promise<string> {
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

      // Inject domain-specific examples if classification is available
      const topClass = this.getTopClass(contentClasses);
      if (topClass) {
        const domainExamples = await this.loadDomainPartial(topClass.class);
        if (domainExamples) {
          context.domainExamples = domainExamples;
          context.detectedContentClass = topClass.class;
        } else {
          // No example file, but still pass the class name for context
          context.detectedContentClass = topClass.class;
        }
        this.logger.debug(
          `Domain routing: ${topClass.class} (confidence: ${topClass.confidence.toFixed(2)})`
        );
      }

      // Enhance context with computed properties (like directory tree)
      const enhancedContext = await this.templateEngine.enhanceContext(context);

      return await this.templateEngine.renderFile(templatePath, enhancedContext);
    } catch (error) {
      this.logger.error(`Failed to render system prompt: ${error}`);
      // Fallback to a basic prompt
      return this.getFallbackSystemPrompt(input, filter);
    }
  }

  /**
   * Get the user prompt for a file, optionally enriched with domain hints
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

      // Add domain hints from NER_DOMAIN_EXAMPLES if classification is available
      const domainHints = this.buildDomainHints(context.contentClasses);
      if (domainHints) {
        templateContext.domainHints = domainHints;
      }

      // Add the corpus glossary (canonical names/types) as a soft naming hint.
      const corpusGlossary = this.buildCorpusGlossaryHint(context.corpusGlossary);
      if (corpusGlossary) {
        templateContext.corpusGlossary = corpusGlossary;
      }

      // Enhance context
      const enhancedContext = await this.templateEngine.enhanceContext(templateContext);

      return await this.templateEngine.renderFile(templatePath, enhancedContext);
    } catch (error) {
      this.logger.error(`Failed to render user prompt: ${error}`);
      // Fallback to basic prompt
      return this.getFallbackUserPrompt(context);
    }
  }

  /**
   * Set the system prompt version
   */
  setSystemPromptVersion(version: string): void {
    this.systemPromptVersion = version;
    this.logger.info(`Using system prompt version: ${version}`);
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
      this.logger.error(`Failed to render custom template: ${error}`);
      throw error;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Returns the top classification result if it meets the confidence threshold,
   * otherwise undefined.
   */
  private getTopClass(
    contentClasses?: ClassificationResult[]
  ): ClassificationResult | undefined {
    if (!contentClasses || contentClasses.length === 0) return undefined;
    const top = contentClasses[0]; // already sorted descending by confidence
    return top.confidence >= LOW_CONFIDENCE_THRESHOLD ? top : undefined;
  }

  /**
   * Builds a human-readable domain hints string from classification results.
   * Handles mixed-domain case (top-2 classes within MIXED_DOMAIN_THRESHOLD).
   */
  private buildDomainHints(contentClasses?: ClassificationResult[]): string | undefined {
    if (!contentClasses || contentClasses.length === 0) return undefined;

    const sorted = [...contentClasses].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0];
    if (top.confidence < LOW_CONFIDENCE_THRESHOLD) return undefined;

    // Determine active classes (top 1, or top 2 if close in confidence)
    const activeClasses: ContentClass[] = [top.class];
    if (
      sorted.length > 1 &&
      sorted[1].confidence >= LOW_CONFIDENCE_THRESHOLD &&
      top.confidence - sorted[1].confidence <= MIXED_DOMAIN_THRESHOLD
    ) {
      activeClasses.push(sorted[1].class);
    }

    const lines: string[] = [];

    if (activeClasses.length === 1) {
      lines.push(`Detected content type: **${top.class}** (confidence: ${top.confidence.toFixed(2)})`);
    } else {
      lines.push(
        `Detected content type: **${activeClasses[0]}** (${sorted[0].confidence.toFixed(2)}) / **${activeClasses[1]}** (${sorted[1].confidence.toFixed(2)}) — mixed domain`
      );
    }

    // Gather entity and relation types from all active classes
    const entityTypes = new Set<string>();
    const relationTypes = new Set<string>();

    for (const cls of activeClasses) {
      const nerInfo = NER_DOMAIN_EXAMPLES[cls];
      if (nerInfo) {
        nerInfo.primaryEntityTypes.forEach(t => entityTypes.add(t));
        nerInfo.primaryRelationTypes.forEach(t => relationTypes.add(t));
      }
    }

    if (entityTypes.size > 0) {
      lines.push(`Prioritize these entity types: ${Array.from(entityTypes).join(', ')}`);
    }
    if (relationTypes.size > 0) {
      lines.push(`Prioritize these relation types: ${Array.from(relationTypes).join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Renders the corpus glossary as a soft-hint block: prefer these canonical
   * names/types when they apply, but never force-fit (so new entities discovered
   * in a chunk are still extracted). Returns undefined when the glossary is empty.
   */
  private buildCorpusGlossaryHint(glossary?: CorpusGlossary): string | undefined {
    if (!glossary) return undefined;
    const { entityNames, entityTypes, relationTypes } = glossary;
    if (
      entityNames.length === 0 &&
      entityTypes.length === 0 &&
      relationTypes.length === 0
    ) {
      return undefined;
    }

    const lines: string[] = [
      'When a concept below appears, reuse its exact canonical form for the entity ' +
        'name (do not invent spelling variants); do NOT force-fit — extract new ' +
        'entities not listed here as usual.',
    ];
    if (entityNames.length > 0) {
      lines.push(`Canonical entity names: ${entityNames.join(', ')}`);
    }
    if (entityTypes.length > 0) {
      lines.push(`Preferred entity types: ${entityTypes.join(', ')}`);
    }
    if (relationTypes.length > 0) {
      lines.push(`Preferred relation types: ${relationTypes.join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Loads and caches the content of a domain example partial file.
   * Returns undefined if the file doesn't exist or is a stub (≤ 3 lines).
   */
  private async loadDomainPartial(contentClass: ContentClass): Promise<string | undefined> {
    const filename = CLASS_TO_PARTIAL[contentClass];
    if (!filename) return undefined;

    if (this.domainPartialCache.has(filename)) {
      const cached = this.domainPartialCache.get(filename)!;
      return cached.length > 0 ? cached : undefined;
    }

    const partialPath = path.join(this.templatesDir, 'partials', 'examples', filename);
    try {
      const content = fs.readFileSync(partialPath, 'utf-8').trim();
      // Treat files with ≤ 3 lines as stubs (placeholder content)
      const isStub = content.split('\n').length <= 3;
      const result = isStub ? '' : content;
      this.domainPartialCache.set(filename, result);
      return result.length > 0 ? result : undefined;
    } catch {
      this.domainPartialCache.set(filename, '');
      return undefined;
    }
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
}
