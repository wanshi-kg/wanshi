import * as path from 'path';
import { z } from 'zod';
import { ILLMProvider, LLMMessage } from '../../types/ILLMProvider';
import { PromptManager, PromptContext } from '../llm/prompts/PromptManager';
import { ProcessedFile, KnowledgeGraph, ProcessedImage, IKnowledgeGraphBuilder, ClassificationResult, IProgressEmitter, ChunkProvenance, Observation, normalizeObservations, GroundingMode, CorpusGlossary } from '../../types';
import { CheckpointService } from '../checkpoint';
import { NoopProgressEmitter } from '../progress';
import { NER_DOMAIN_EXAMPLES } from '../processor/classifier/NER_DOMAIN_EXAMPLES';
import { FactualEvaluator } from '../../quality';
import { Logger, shutdown } from '../../shared';

/**
 * Domain-agnostic entity types always offered alongside a detected domain's
 * vocabulary, plus an `other` escape hatch so the model is never forced to
 * mislabel when nothing fits.
 */
/**
 * Base controlled vocabularies (v5). These mirror the `{{else}}` base lists in
 * `templates/v5/system.hbs` — keep the two in sync (a future refinement renders
 * the template list from these constants). The escape hatches (`other` for
 * entities, `related_to` for relations) keep the model from being forced to
 * mislabel and prevent validation-failure recall loss.
 */
const BASE_ENTITY_TYPES = [
  "person", "organization", "location", "role", "event", "time", "metric",
  "concept", "term", "document", "product", "technology", "standard",
  "class", "interface", "function", "module", "service", "dependency",
  "data_structure", "config", "file",
];

const BASE_RELATION_TYPES = [
  "uses", "depends_on", "calls", "implements", "extends", "contains", "part_of",
  "produces", "consumes", "configures", "references", "defines", "targets",
  "located_in", "works_at", "member_of", "precedes", "causes", "has_attribute",
  "related_to",
];

/** Back-compat alias: generic entity types still used by the type resolver. */
const GENERIC_ENTITY_TYPES = BASE_ENTITY_TYPES;

/**
 * Build the extraction schema. Under v5 both vocabularies are *closed*: when an
 * allowed set is supplied, the field is an enforced Zod enum; `entityType` falls
 * back to the base set + `other`, `relationType` to the base set + `related_to`,
 * so the model can never invent a one-off type/predicate. When a set is empty the
 * field stays a free string (legacy behavior, e.g. older prompt versions).
 */
function buildGraphSchema(allowedTypes?: string[], allowedRelationTypes?: string[]) {
  const entityType =
    allowedTypes && allowedTypes.length > 0
      ? z
          .enum(allowedTypes as [string, ...string[]])
          .describe("Entity type — pick the closest; use 'other' if none fit")
      : z.string().describe("Entity description");

  const relationType =
    allowedRelationTypes && allowedRelationTypes.length > 0
      ? z
          .array(z.enum(allowedRelationTypes as [string, ...string[]]))
          .describe("One canonical predicate; use 'related_to' if none fit")
      : z.array(z.string()).describe("List of relation types");

  return z.object({
    entities: z.array(
      z.object({
        name: z.string().describe("Unique entity name"),
        entityType,
        observations: z
          .array(z.string())
          .describe("List of facts and observations about entity"),
      })
    ),
    relations: z.array(
      z.object({
        from: z.string().describe("Relation source entity"),
        to: z.string().describe("Relation target entity"),
        relationType,
      })
    ),
  });
}

const DEFAULT_GRAPH_SCHEMA = buildGraphSchema();

/** What the LLM returns: observations are still bare strings here. */
type RawGraph = z.infer<typeof DEFAULT_GRAPH_SCHEMA>;

export interface BuilderOptions {
  llmService: ILLMProvider;
  promptManager: PromptManager;
  // Resume support: when `resume` is set, each chunk's result is read from /
  // written to the checkpoint, keyed by content + model + prompt version.
  checkpoint?: CheckpointService;
  resume?: boolean;
  model: string;
  promptVersion?: string;
  // Discovery root (`options.input`). The checkpoint key uses the file path
  // *relative to this root* so moving the whole tree / changing the `input`
  // prefix doesn't invalidate the checkpoint.
  inputRoot?: string;
  // Optional structured-progress sink (per-chunk start/complete events).
  // Defaults to a no-op emitter.
  progress?: IProgressEmitter;
  // Inline grounding gate: check each extracted observation against its source
  // chunk and flag/drop ungrounded ones. Defaults to disabled.
  grounding?: GroundingMode;
  groundingMinScore?: number;
  // When set, stamp each relation with the chunk text it was extracted from
  // (`Relation.sourceSpan`), so the post-merge co-occurrence grounding gate (and
  // Experiment 2) can judge edges. Off by default — keeps the baseline graph
  // free of the extra weight. Wired from `pipeline.grounding.enabled`.
  attachSourceSpans?: boolean;
}

/**
 * Builds knowledge graphs from processed files using LLM
 */
export class KnowledgeGraphBuilder implements IKnowledgeGraphBuilder {
  private llmService: ILLMProvider;
  private promptManager: PromptManager;
  private checkpoint?: CheckpointService;
  private resume: boolean;
  private model: string;
  private promptVersion: string;
  private inputRoot: string;
  private logger: Logger;
  private progress: IProgressEmitter;
  private grounding: GroundingMode;
  private groundingMinScore: number;
  private attachSourceSpans: boolean;

  constructor(options: BuilderOptions, logger: Logger) {
    this.llmService = options.llmService;
    this.promptManager = options.promptManager;
    this.checkpoint = options.checkpoint;
    this.resume = options.resume ?? false;
    this.model = options.model;
    this.promptVersion = options.promptVersion ?? 'default';
    this.inputRoot = options.inputRoot ?? '';
    this.logger = logger;
    this.progress = options.progress ?? new NoopProgressEmitter();
    this.grounding = options.grounding ?? 'disabled';
    this.groundingMinScore = options.groundingMinScore ?? 0.5;
    this.attachSourceSpans = options.attachSourceSpans ?? false;
  }

  /**
   * Stable identity for a file in the checkpoint key: the path relative to the
   * discovery root (`inputRoot`), normalized to posix separators. This makes
   * resume survive relocating the whole input tree or changing the `input`
   * prefix. Falls back to the raw path when there's no root or the file resolves
   * outside it (`..`), so behavior degrades gracefully rather than mis-keying.
   */
  private stablePathId(filePath: string): string {
    if (!this.inputRoot) return filePath;
    const rel = path.relative(this.inputRoot, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
    return rel.split(path.sep).join('/');
  }

  /**
   * Build a knowledge graph from a processed file
   */
  async build(
    processedFile: ProcessedFile,
    systemPrompt: string,
    retrieve?: (chunkContent: string) => Promise<any>,
    glossary?: CorpusGlossary
  ): Promise<KnowledgeGraph[]> {
    this.logger.info(`Building knowledge graph for: ${processedFile.path}`);

    const graphs: KnowledgeGraph[] = [];

    const contentClasses = processedFile.metadata?.classes;
    const multiChunk = processedFile.chunks.length > 1;

    // Process chunks if available
    if (multiChunk) {
      for (const chunk of processedFile.chunks) {
        // Cooperative interrupt: finish the in-flight chunk, then stop before
        // starting the next one so a partial graph can be flushed.
        if (shutdown.isRequested()) {
          this.logger.warn(
            `Interrupted — stopping at chunk ${chunk.index}/${chunk.totalChunks} of ${processedFile.path}`
          );
          break;
        }

        // Retrieve context for THIS chunk's content (per-chunk retrieval).
        const retrievedContext = retrieve ? await retrieve(chunk.content) : undefined;

        const kg = await this.buildChunk(
          processedFile.path,
          chunk.index,
          chunk.totalChunks,
          chunk.content,
          this.chunkProvenance(processedFile, chunk),
          () =>
            this.buildFromChunk(
              processedFile.path,
              chunk.content,
              processedFile.content ?? '', // full file text → outline + grounding
              systemPrompt,
              chunk.index,
              chunk.totalChunks,
              retrievedContext,
              chunk.images,
              contentClasses,
              glossary
            ),
          (entity) => {
            entity.files = [processedFile.path];
            entity.chunk = chunk.index;
            entity.totalChunks = chunk.totalChunks;
          }
        );

        graphs.push(kg);
      }
    } else if (processedFile.chunks.length === 1) {
      const chunk = processedFile.chunks[0];
      const { content, images } = chunk;
      const retrievedContext = retrieve ? await retrieve(content) : undefined;
      // Process entire file
      const kg = await this.buildChunk(
        processedFile.path,
        chunk.index ?? 1,
        chunk.totalChunks ?? 1,
        content,
        this.chunkProvenance(processedFile, chunk),
        () =>
          this.buildFromContent(
            processedFile.path,
            content,
            systemPrompt,
            retrievedContext,
            images,
            contentClasses,
            glossary
          ),
        (entity) => {
          entity.files = [processedFile.path];
        }
      );

      graphs.push(kg);
    }

    // Pin ingest-time document identity (reader metadata) as its own entity.
    // Never trusted to extraction: body text is full of OTHER papers' IDs, and a
    // cited paper's arXiv ID binding onto the host document is the worst-case
    // provenance failure.
    const identity = this.documentIdentityGraph(processedFile);
    if (identity) graphs.push(identity);

    return graphs;
  }

  /** Build the pinned `document` entity from reader-supplied identity metadata. */
  private documentIdentityGraph(processedFile: ProcessedFile): KnowledgeGraph | null {
    const arxivId = processedFile.metadata?.arxivId as string | undefined;
    const title = processedFile.metadata?.title as string | undefined;
    if (!arxivId && !title) return null;

    const createdAt = new Date().toISOString();
    const observations: Observation[] = [];
    if (title) {
      observations.push({ text: `Title: ${title}`, source: processedFile.path, createdAt });
    }
    if (arxivId) {
      observations.push({ text: `arXiv:${arxivId}`, source: processedFile.path, createdAt });
    }

    const name = title ?? path.basename(processedFile.path);
    this.logger.info(`Pinned document identity for ${processedFile.path}: ${name}`);
    return {
      entities: [
        {
          name,
          entityType: "document",
          files: [processedFile.path],
          observations,
        },
      ],
      relations: [],
    };
  }

  /**
   * Run one chunk through the LLM, or restore it from the checkpoint when
   * resuming. Stored graphs already carry their entity metadata, so on a hit
   * we skip the LLM call entirely.
   */
  private async buildChunk(
    filePath: string,
    chunkIndex: number,
    totalChunks: number,
    content: string,
    provenance: ChunkProvenance,
    generate: () => Promise<RawGraph>,
    attachMetadata: (entity: KnowledgeGraph['entities'][number]) => void
  ): Promise<KnowledgeGraph> {
    this.progress.emit({
      type: "chunk_start",
      path: filePath,
      chunk: chunkIndex,
      totalChunks,
    });

    const relPath = this.stablePathId(filePath);
    const key =
      this.resume && this.checkpoint
        ? this.checkpoint.computeKey(
            relPath,
            chunkIndex,
            content,
            this.model,
            this.promptVersion
          )
        : undefined;

    if (key && this.checkpoint!.has(key)) {
      this.logger.info(
        `Skipping cached chunk ${chunkIndex}/${totalChunks} of ${filePath} (checkpoint hit)`
      );
      const cached = this.normalizeGraph(this.checkpoint!.get(key)!);
      this.progress.emit({
        type: "chunk_complete",
        path: filePath,
        chunk: chunkIndex,
        totalChunks,
        entities: cached.entities.length,
        relations: cached.relations.length,
        cached: true,
      });
      return cached;
    }

    const raw = await generate();
    const kg = this.applyGroundingGate(this.toGraph(raw, provenance, content), content);
    kg.entities.forEach(attachMetadata);

    this.progress.emit({
      type: "chunk_complete",
      path: filePath,
      chunk: chunkIndex,
      totalChunks,
      entities: kg.entities.length,
      relations: kg.relations.length,
      cached: false,
    });

    if (key) {
      await this.checkpoint!.append({
        key,
        filePath,
        relPath,
        chunkIndex,
        totalChunks,
        model: this.model,
        promptVersion: this.promptVersion,
        kg,
      });
    }

    return kg;
  }

  /**
   * Scope the entity-type enum: the detected content domain's `primaryEntityTypes`
   * unioned with any corpus-glossary entity types + the base set + `other`. Under
   * v5 the vocabulary is *always closed* — with no class and no glossary it still
   * returns the base set (+`other`) rather than `undefined`, so `entityType` is an
   * enforced enum even on an un-profiled, un-classified run. The `other` escape
   * keeps the model from being forced to mislabel.
   */
  private resolveAllowedTypes(
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary
  ): string[] | undefined {
    const glossaryTypes = glossary?.entityTypes ?? [];
    let domain: string[] = [];
    if (contentClasses && contentClasses.length > 0) {
      const top = contentClasses.reduce((a, b) =>
        b.confidence > a.confidence ? b : a
      );
      domain = NER_DOMAIN_EXAMPLES[top.class]?.primaryEntityTypes ?? [];
    }
    return Array.from(
      new Set([...domain, ...glossaryTypes, ...BASE_ENTITY_TYPES, "other"])
    );
  }

  /**
   * Scope the relation-predicate enum: corpus-glossary relation types unioned with
   * the base predicate set + `related_to` catch-all. Always closed (mirror of
   * {@link resolveAllowedTypes}), so `relationType` is an enforced enum — the
   * prompt-side fix to the predicate explosion (523→826 distinct types) backed by
   * schema validation.
   */
  private resolveAllowedRelationTypes(glossary?: CorpusGlossary): string[] {
    const glossaryRelations = glossary?.relationTypes ?? [];
    return Array.from(
      new Set([...glossaryRelations, ...BASE_RELATION_TYPES, "related_to"])
    );
  }

  /** Provenance to stamp on a chunk's observations (reader-supplied or file). */
  private chunkProvenance(
    processedFile: ProcessedFile,
    chunk: { provenance?: ChunkProvenance }
  ): ChunkProvenance {
    return {
      speaker: chunk.provenance?.speaker,
      source: chunk.provenance?.source ?? processedFile.path,
      occurredAt: chunk.provenance?.occurredAt,
    };
  }

  /**
   * Convert the LLM's raw graph (bare-string observations) into the domain
   * graph, stamping each observation with the chunk's provenance + transaction
   * time. Grounding is deterministic — we attach what we already know rather
   * than asking the model for it.
   */
  private toGraph(
    raw: RawGraph,
    provenance: ChunkProvenance,
    content: string
  ): KnowledgeGraph {
    const createdAt = new Date().toISOString();
    return {
      entities: raw.entities.map((e) => ({
        name: e.name,
        entityType: e.entityType,
        files: [],
        observations: e.observations.map(
          (text): Observation => ({
            text,
            ...(provenance.speaker ? { speaker: provenance.speaker } : {}),
            ...(provenance.source ? { source: provenance.source } : {}),
            ...(provenance.occurredAt ? { validAt: provenance.occurredAt } : {}),
            createdAt,
          })
        ),
      })),
      relations: raw.relations.map((r) => ({
        from: r.from,
        to: r.to,
        relationType: r.relationType,
        // Only stamp the span when a consumer (the grounding gate) is active, so
        // the default/baseline graph carries no extra weight.
        ...(this.attachSourceSpans ? { sourceSpan: content } : {}),
        ...(this.attachSourceSpans && provenance.occurredAt
          ? { validAt: provenance.occurredAt }
          : {}),
      })),
    };
  }

  /**
   * Inline grounding gate: score each observation against its source chunk and
   * either flag (annotate, keep) or drop the ungrounded ones. No-op when
   * disabled. The score is a cheap keyword-overlap heuristic (FactualEvaluator),
   * which is the seam for a stronger check later.
   */
  private applyGroundingGate(kg: KnowledgeGraph, source: string): KnowledgeGraph {
    if (this.grounding === 'disabled' || !source) return kg;
    const min = this.groundingMinScore;
    let dropped = 0;
    for (const e of kg.entities) {
      if (this.grounding === 'drop') {
        const before = e.observations.length;
        e.observations = e.observations.filter(
          (o) => FactualEvaluator.observationGroundingScore(o.text, source) >= min
        );
        dropped += before - e.observations.length;
      } else {
        for (const o of e.observations) {
          const score = FactualEvaluator.observationGroundingScore(o.text, source);
          o.groundingScore = score;
          o.grounded = score >= min;
        }
      }
    }
    if (dropped > 0) {
      this.logger.debug(
        `Grounding gate dropped ${dropped} ungrounded observation(s) (min ${min})`
      );
    }
    return kg;
  }

  /** Normalize a (possibly legacy string-observation) graph from the checkpoint. */
  private normalizeGraph(kg: KnowledgeGraph): KnowledgeGraph {
    return {
      ...kg,
      entities: kg.entities.map((e) => ({
        ...e,
        observations: normalizeObservations(e.observations as any),
      })),
    };
  }

  /**
   * Build knowledge graph from a chunk of content
   */
  private async buildFromChunk(
    filePath: string,
    content: string,
    fullContent: string,
    systemPrompt: string,
    chunkIndex: number,
    totalChunks: number,
    retrievedContext?: any,
    images?: ProcessedImage[],
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary
  ): Promise<RawGraph> {
    this.logger.debug(`Building KG for chunk ${chunkIndex}/${totalChunks} of ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: fullContent,
      chunkContent: content,
      chunkIndex,
      totalChunks,
      retrievedContext,
      contentClasses,
      corpusGlossary: glossary
    });

    return this.generateKnowledgeGraph(
      systemPrompt,
      userPrompt,
      images,
      this.resolveAllowedTypes(contentClasses, glossary),
      this.resolveAllowedRelationTypes(glossary)
    );
  }

  /**
   * Build knowledge graph from entire content
   */
  private async buildFromContent(
    filePath: string,
    content: string,
    systemPrompt: string,
    retrievedContext?: any,
    images?: ProcessedImage[],
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary
  ): Promise<RawGraph> {
    this.logger.debug(`Building KG for entire file: ${filePath}`);

    const userPrompt = await this.promptManager.getUserPrompt({
      input: '',
      filter: '',
      fileName: filePath,
      fileContent: content,
      chunkContent: content,
      retrievedContext,
      contentClasses,
      corpusGlossary: glossary
    });

    return this.generateKnowledgeGraph(
      systemPrompt,
      userPrompt,
      images,
      this.resolveAllowedTypes(contentClasses, glossary),
      this.resolveAllowedRelationTypes(glossary)
    );
  }

  /**
   * Generate knowledge graph using LLM
   */
  private async generateKnowledgeGraph(
    systemPrompt: string,
    userPrompt: string,
    images?: ProcessedImage[],
    allowedTypes?: string[],
    allowedRelationTypes?: string[]
  ): Promise<RawGraph> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: userPrompt,
        images: images?.map(img => img.base64 ?? '')
      }
    ];

    try {
      const result = await this.llmService.generateStructured(
        messages,
        buildGraphSchema(allowedTypes, allowedRelationTypes)
      );

      // Ensure arrays exist
      result.entities ??= [];
      result.relations ??= [];

      this.logger.debug(`Generated KG with ${result.entities.length} entities and ${result.relations.length} relations`);

      return result;
    } catch (error) {
      this.logger.error(`Failed to generate knowledge graph: ${error}`);
      
      // Return empty graph on failure
      return {
        entities: [],
        relations: []
      };
    }
  }
}