import * as path from 'path';
import * as fs from 'fs';
import { PromptTemplateEngine, TemplateContext } from './PromptTemplateEngine';
import { Logger } from '../../../shared';
import { ClassificationResult, ContentClass, CorpusGlossary, OutlineOptions } from '../../../types';
import {
  activeDomainClasses,
  domainVocabulary,
  domainGateThresholds,
} from '../../knowledge/vocabulary';

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
  /**
   * Strict closed vocabulary (KG-05): under strict + a glossary, the Zod enum is
   * glossary∪escape only, so the domain hints must teach *only* the glossary
   * predicates — any domain type the strict enum throws away is dropped from the
   * hints (else it's taught then silently coerced to `related_to`/`other`).
   * Off (default) ⇒ hints rendering is unchanged.
   */
  strictVocabulary?: boolean;
}

/** Maps content class to its example partial filename */
const CLASS_TO_PARTIAL: Record<ContentClass, string> = {
  code:          'code.md',
  financial:     'financial.md',
  medical:       'medical.md',
  legal:         'legal.md',
  technical:     'logs.md',
  research:      'research.md',
  transcript:    'transcript.md',
  tabular:       'tabular.md',
  communication: 'communication.md',
  documentation: 'documentation.md',
  narrative:     'article.md',
  reference:     'notes.md',
};

/**
 * Manages prompt templates using Handlebars templating
 */
export class PromptManager {
  private templateEngine: PromptTemplateEngine;
  private systemPromptVersion: string = 'v5';
  private customSystemPrompt?: string;
  private templatesDir: string;
  private logger: Logger;

  /**
   * Resolves once partials are registered. Every render path awaits it first so
   * a first render can't race the fire-and-forget async init (KG-16) — which
   * previously fell back to a weak prompt with no partials.
   */
  private ready: Promise<void>;

  /** Cache of loaded domain example partial contents keyed by filename */
  private domainPartialCache: Map<string, string> = new Map();

  constructor(logger: Logger, templatesDir?: string, outlineOptions?: OutlineOptions) {
    this.logger = logger;
    this.templateEngine = new PromptTemplateEngine(logger, outlineOptions);
    this.templatesDir = templatesDir || path.join(__dirname, 'templates');
    this.ready = this.initializeTemplates();
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
   * Override the prompt template version (default: 'v5').
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
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary,
    openVocabulary?: boolean,
    strictVocabulary?: boolean
  ): Promise<string> {
    if (this.customSystemPrompt) {
      return this.customSystemPrompt;
    }

    await this.ready; // partials registered before first render (KG-16)

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

      // Open-vocabulary mode (the canonicalization-tax arm): suppress every vocab
      // constraint so the template renders "use any concise predicate" instead of a
      // closed/base set — mirrors the builder dropping the Zod enum. Overrides the
      // glossary (free predicates win over a controlled set).
      if (openVocabulary) {
        context.openVocabulary = true;
      } else {
        // Promote the corpus glossary to the *authoritative* closed vocabularies
        // rendered in the system prompt (v5). Absent → the template falls back to
        // its base entity/relation vocab. Names stay in the user prompt.
        if (glossary?.entityTypes?.length) {
          context.entityTypeVocabulary = glossary.entityTypes.join(', ');
        }
        if (glossary?.relationTypes?.length) {
          context.relationTypeVocabulary = glossary.relationTypes.join(', ');
        }
      }

      // Strict closed vocabulary (KG-05): when a glossary supplies the authoritative
      // ontology, the Zod enum is glossary∪escape only — so the domain worked-examples
      // partial (which demonstrates domain predicates the strict enum forbids) must
      // NOT be injected; teaching them only to have the per-field `.catch` coerce them
      // to `related_to`/`other` is exactly the bug. Off (default) ⇒ examples unchanged.
      const strictOntology =
        !!strictVocabulary &&
        (!!glossary?.entityTypes?.length || !!glossary?.relationTypes?.length);

      // Inject domain-specific examples if classification is available
      const topClass = strictOntology ? undefined : this.getTopClass(contentClasses);
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
    await this.ready; // partials registered before first render (KG-16)
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

      // Add domain hints from NER_DOMAIN_EXAMPLES if classification is available.
      // Under strict vocabulary (KG-05) the glossary types are the authoritative
      // ontology, so the hints are restricted to them — domain types the strict
      // enum throws away must not be taught (else they coerce to related_to/other).
      const domainHints = this.buildDomainHints(
        context.contentClasses,
        context.strictVocabulary ? context.corpusGlossary : undefined
      );
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
    await this.ready; // partials registered before first render (KG-16)
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
    return top.confidence >= domainGateThresholds().lowConfidence ? top : undefined;
  }

  /**
   * Builds a human-readable domain hints string from classification results.
   * Handles mixed-domain case (top-2 classes within MIXED_DOMAIN_THRESHOLD).
   *
   * `strictGlossary` (KG-05): when supplied (strict vocabulary on + a glossary),
   * the prioritized entity/relation type lines are intersected with the glossary's
   * types — under strict the Zod enum is glossary∪escape only, so a domain type
   * not in the glossary must not be taught (the per-field `.catch` would otherwise
   * silently coerce it to `related_to`/`other`). Absent ⇒ unchanged hints.
   */
  private buildDomainHints(
    contentClasses?: ClassificationResult[],
    strictGlossary?: CorpusGlossary
  ): string | undefined {
    // Class selection + vocabulary come from the shared single source so the
    // hints can never diverge from the Zod enum (KG-05).
    const activeClasses = activeDomainClasses(contentClasses);
    if (activeClasses.length === 0) return undefined;

    const sorted = [...contentClasses!].sort((a, b) => b.confidence - a.confidence);
    const lines: string[] = [];

    if (activeClasses.length === 1) {
      lines.push(`Detected content type: **${sorted[0].class}** (confidence: ${sorted[0].confidence.toFixed(2)})`);
    } else {
      lines.push(
        `Detected content type: **${activeClasses[0]}** (${sorted[0].confidence.toFixed(2)}) / **${activeClasses[1]}** (${sorted[1].confidence.toFixed(2)}) — mixed domain`
      );
    }

    const { entityTypes, relationTypes } = domainVocabulary(contentClasses);
    let uniqueEntityTypes = Array.from(new Set(entityTypes));
    let uniqueRelationTypes = Array.from(new Set(relationTypes));

    // Strict: keep only the domain types the strict enum actually allows.
    if (strictGlossary) {
      const allowedEntity = new Set(strictGlossary.entityTypes ?? []);
      const allowedRelation = new Set(strictGlossary.relationTypes ?? []);
      uniqueEntityTypes = uniqueEntityTypes.filter((t) => allowedEntity.has(t));
      uniqueRelationTypes = uniqueRelationTypes.filter((t) => allowedRelation.has(t));
    }

    if (uniqueEntityTypes.length > 0) {
      lines.push(`Prioritize these entity types: ${uniqueEntityTypes.join(', ')}`);
    }
    if (uniqueRelationTypes.length > 0) {
      lines.push(`Prioritize these relation types: ${uniqueRelationTypes.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Renders the corpus glossary block for the user prompt (v5: authoritative).
   * Focuses on canonical entity *names* — the established entity/relation *types*
   * are now the closed vocabularies in the system prompt, so this avoids
   * duplicating them. New entities not listed are still extracted as usual.
   * Returns undefined when the glossary is empty.
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

    const lines: string[] = [];
    if (entityNames.length > 0) {
      lines.push(`Canonical entity names: ${entityNames.join(', ')}`);
    }
    if (entityTypes.length > 0) {
      lines.push(`Established entity types: ${entityTypes.join(', ')}`);
    }
    if (relationTypes.length > 0) {
      lines.push(`Established relation predicates: ${relationTypes.join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Render the glossary-generation system + user prompts for the corpus pre-pass
   * from `templates/<version>/glossary/{system,user}.hbs`. Falls back to `undefined`
   * when the current version ships no glossary templates (e.g. v4.5), so the caller
   * (CorpusAnalyzer) keeps its inline-string prompts. Non-fatal: a render failure
   * also returns undefined.
   */
  async getGlossaryPrompt(
    vars: { classLine: string; termList: string; snippets: string }
  ): Promise<{ system: string; user: string } | undefined> {
    await this.ready; // partials registered before first render (KG-16)
    const dir = path.join(this.templatesDir, this.systemPromptVersion, 'glossary');
    const systemPath = path.join(dir, 'system.hbs');
    const userPath = path.join(dir, 'user.hbs');
    if (!fs.existsSync(systemPath) || !fs.existsSync(userPath)) {
      return undefined;
    }
    try {
      const system = await this.templateEngine.renderFile(systemPath, {});
      const user = await this.templateEngine.renderFile(userPath, vars);
      return { system, user };
    } catch (error) {
      this.logger.warn(`Failed to render glossary prompt (using inline fallback): ${error}`);
      return undefined;
    }
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
