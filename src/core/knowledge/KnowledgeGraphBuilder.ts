import * as path from 'path';
import * as crypto from 'crypto';
import { z } from 'zod';
import { ILLMProvider, LLMMessage, LLMUsage } from '../../types/ILLMProvider';
import { PromptManager, PromptContext } from '../llm/prompts/PromptManager';
import { ProcessedFile, KnowledgeGraph, ProcessedImage, IKnowledgeGraphBuilder, ClassificationResult, IProgressEmitter, ChunkProvenance, Observation, obsText, normalizeObservations, GroundingMode, CorpusGlossary, FailedChunk, GroundingRejection, IGroundingChecker } from '../../types';
import { CheckpointService } from '../checkpoint';
import { NoopProgressEmitter } from '../progress';
import { allowedEntityTypes, allowedRelationTypes, ENTITY_TYPE_ESCAPE, RELATION_TYPE_ESCAPE } from './vocabulary';
import { KeywordGroundingChecker, verbalizeRelation } from './grounding';
import { Logger, shutdown } from '../../shared';
import { trace, LineageRegistry } from '../trace';

/**
 * Build the extraction schema. Under v5 both vocabularies are *closed*: when an
 * allowed set is supplied, the field is a Zod enum; `entityType` falls back to the
 * base set + `other`, `relationType` to the base set + `related_to`, so the model
 * can never invent a one-off type/predicate. When a set is empty the field stays a
 * free string (legacy behavior, e.g. older prompt versions).
 *
 * **Lenient coercion (recall guard):** the enum is wrapped in `.catch(escape)`, so an
 * out-of-vocab value the model emits anyway (e.g. `relationType: "returns"`, which
 * Ollama's soft `format` constraint doesn't reliably prevent) is coerced onto the
 * catch-all (`other` / `related_to`) **per field** instead of failing Zod and
 * discarding the *entire chunk* (3 retries → empty graph). This is the escapes'
 * intended purpose ("prevent validation-failure recall loss"); coerced values surface
 * in `KnowledgeMerger.logVocabularyFit`'s catch-all fraction (the too-tight-vocab
 * signal), so nothing goes silent.
 */
export function buildGraphSchema(allowedTypes?: string[], allowedRelationTypes?: string[]) {
  const hasTypes = !!allowedTypes && allowedTypes.length > 0;
  const hasRel = !!allowedRelationTypes && allowedRelationTypes.length > 0;
  const entityEscape = hasTypes ? (allowedTypes!.includes("other") ? "other" : allowedTypes![0]) : "other";
  const relEscape = hasRel
    ? allowedRelationTypes!.includes("related_to")
      ? "related_to"
      : allowedRelationTypes![0]
    : "related_to";

  const entityType = hasTypes
    ? z
        .enum(allowedTypes as [string, ...string[]])
        .catch(entityEscape)
        .describe("Entity type — pick the closest; use 'other' if none fit")
    : z.string().describe("Entity description");

  // v5's prompt asks for "one canonical predicate", so instruction-following models
  // (e.g. gemma4) emit relationType as a scalar string ("depends_on") rather than a
  // one-element array. Coerce scalar → [scalar] before validating so a compliant model
  // isn't rejected; the array path is unchanged.
  const toRelationArray = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const relationType = hasRel
    ? z
        .preprocess(
          toRelationArray,
          z.array(z.enum(allowedRelationTypes as [string, ...string[]]).catch(relEscape))
        )
        .describe("One canonical predicate; use 'related_to' if none fit")
    : z.preprocess(toRelationArray, z.array(z.string())).describe("List of relation types");

  return z.object({
    entities: z.array(
      z.object({
        name: z.string().describe("Unique entity name"),
        entityType,
        // Models often emit referenced-but-undescribed entities with no observations
        // field at all; default to [] so a missing array doesn't reject the whole chunk
        // (and so observations drops out of the JSON-schema `required` list).
        observations: z
          .array(z.string())
          .default([])
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

/**
 * What the LLM returns: observations are still bare strings here. Declared
 * explicitly (not `z.infer`) because the `relationType` scalar→array coercion uses
 * `z.preprocess`, whose output type doesn't survive `z.infer` through `z.object`.
 */
type RawGraph = {
  entities: { name: string; entityType: string; observations: string[] }[];
  relations: { from: string; to: string; relationType: string[] }[];
};

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
  // The checker the gate routes through (keyword overlap | MiniCheck NLI).
  // Defaults to a keyword checker, preserving pre-Phase-5 behavior.
  groundingChecker?: IGroundingChecker;
  // Folded into the checkpoint key so toggling grounding between --resume runs
  // re-extracts affected chunks instead of reusing a differently-gated graph
  // (scoped slice of KG-07). Built by ContainerFactory from the grounding config.
  groundingSignature?: string;
  // When set, stamp each relation with the chunk text it was extracted from
  // (`Relation.sourceSpan`), so the post-merge co-occurrence grounding gate (and
  // Experiment 2) can judge edges. Off by default — keeps the baseline graph
  // free of the extra weight. Wired from `pipeline.grounding.enabled`.
  attachSourceSpans?: boolean;
  // Free-vocabulary extraction: skip the closed entity/relation enum entirely so
  // the model emits any predicate/type (no `related_to`/`other` coercion). The
  // canonicalization-tax measurement. Wired from `pipeline.extraction.openPredicate`.
  openPredicate?: boolean;
  // Strict closed vocabulary: a supplied glossary's entity/relation types REPLACE the
  // base/domain sets (enum = glossary ∪ escape only), instead of unioning with them.
  // For feeding a known ontology as the authoritative schema. Wired from
  // `pipeline.extraction.strictVocabulary`. Ignored when openPredicate is on.
  strictVocabulary?: boolean;
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
  private openPredicate: boolean;
  private strictVocabulary: boolean;
  private groundingMinScore: number;
  private groundingChecker: IGroundingChecker;
  private groundingSignature: string;
  private attachSourceSpans: boolean;
  /** Chunks whose extraction threw this run — left uncheckpointed (KG-02). */
  private failedChunks: FailedChunk[] = [];
  /** Claims the grounding gate rejected this run (WI3 manifest trace). */
  private groundingRejections: GroundingRejection[] = [];

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
    this.groundingChecker =
      options.groundingChecker ?? new KeywordGroundingChecker(this.groundingMinScore);
    this.groundingSignature = options.groundingSignature ?? '';
    this.attachSourceSpans = options.attachSourceSpans ?? false;
    this.openPredicate = options.openPredicate ?? false;
    this.strictVocabulary = options.strictVocabulary ?? false;
  }

  /** Chunks whose extraction failed this run (empty when all succeeded). */
  getFailedChunks(): FailedChunk[] {
    return this.failedChunks;
  }

  /** Claims the inline grounding gate rejected this run (empty when none/off). */
  getGroundingRejections(): GroundingRejection[] {
    return this.groundingRejections;
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
   * The *deterministic* extraction inputs other than the chunk's own text (KG-07),
   * folded into the checkpoint key's `extra` so toggling any of them between
   * `--resume` runs re-extracts the affected chunks instead of silently reusing a
   * graph built under different settings: the grounding signature (Phase 5, now
   * including `escalateAbove`+`host`), the rendered system prompt (which already
   * encodes the resolved entity/relation vocabulary + domain examples → the "schema
   * shape"), the corpus glossary, and the classifier classes. Also `strictVocabulary`
   * + `openPredicate`: these change the resolved Zod *enum* (glossary REPLACES vs.
   * augments the base sets / drops the enum entirely) **without** changing the
   * system-prompt string, so they'd be invisible to the key otherwise (KG-07).
   *
   * Deliberately EXCLUDES the chunk's retrieved context: retrieval pulls from the
   * graph built by *prior* (temperature>0, non-deterministic) extractions, so it
   * differs on every run. Folding it into the key made the key unstable across runs
   * and defeated `--resume` entirely whenever retrieval was on (the default) — a
   * re-run after a crash matched nothing and re-extracted (and re-billed) every
   * chunk. The key must hash deterministic *inputs*, never volatile *outputs*.
   */
  private extractionExtra(
    systemPrompt: string,
    glossary: CorpusGlossary | undefined,
    contentClasses: ClassificationResult[] | undefined
  ): string {
    const h = crypto.createHash('sha1');
    for (const part of [
      this.groundingSignature,
      systemPrompt,
      glossary ? JSON.stringify(glossary) : '',
      contentClasses ? JSON.stringify(contentClasses) : '',
      this.strictVocabulary ? 'strict' : '',
      this.openPredicate ? 'open' : '',
    ]) {
      h.update(part);
      h.update('\x00');
    }
    return h.digest('hex');
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
          },
          this.extractionExtra(systemPrompt, glossary, contentClasses)
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
        },
        this.extractionExtra(systemPrompt, glossary, contentClasses)
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
    attachMetadata: (entity: KnowledgeGraph['entities'][number]) => void,
    extractionExtra: string
  ): Promise<KnowledgeGraph> {
    this.progress.emit({
      type: "chunk_start",
      path: filePath,
      chunk: chunkIndex,
      totalChunks,
    });

    const relPath = this.stablePathId(filePath);
    const chunkId = `${relPath}#${chunkIndex}`;
    const extractionId = `${chunkId}@0`;
    const key =
      this.resume && this.checkpoint
        ? this.checkpoint.computeKey(
            relPath,
            chunkIndex,
            content,
            this.model,
            this.promptVersion,
            extractionExtra
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
      // Mint/register the cached chunk's mentions too so lineage works on resume.
      this.traceExtraction(cached, { extractionId, chunkId, filePath, chunkIndex, checkpointHit: true });
      return cached;
    }

    let raw: RawGraph;
    try {
      raw = await generate();
    } catch (error) {
      // Extraction threw (retries exhausted, truncation, network/credits).
      // Record it and return an empty graph WITHOUT checkpointing, so the chunk
      // is retried on the next --resume rather than cached as done-and-empty.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Extraction failed for chunk ${chunkIndex}/${totalChunks} of ${filePath} ` +
          `— left uncheckpointed so --resume retries it: ${message}`
      );
      this.failedChunks.push({ filePath, chunkIndex, totalChunks, error: message });
      this.progress.emit({
        type: "chunk_failed",
        path: filePath,
        chunk: chunkIndex,
        totalChunks,
        error: message,
      });
      this.traceExtraction({ entities: [], relations: [] }, { extractionId, chunkId, filePath, chunkIndex, checkpointHit: false, failed: true, error: message });
      return { entities: [], relations: [] };
    }

    const usage = this.llmService.getLastUsage?.();
    const graph0 = this.toGraph(raw, provenance, content);
    // Register mention IDs (pre-grounding) + emit the extraction event. Mention IDs
    // are derived deterministically from content, so grounding can reference them
    // without anything being stored on the graph objects (observe-only).
    this.traceExtraction(graph0, { extractionId, chunkId, filePath, chunkIndex, checkpointHit: false, usage });
    const kg = await this.applyGroundingGate(
      graph0,
      content,
      filePath,
      chunkIndex,
      extractionId
    );
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
   * Scope the entity-type enum: the active content domain's `primaryEntityTypes`
   * ∪ corpus-glossary entity types ∪ base set ∪ `other`. Delegates to the shared
   * {@link allowedEntityTypes} so the enum and the prompt hints derive from one
   * source. Always closed — with no class and no glossary it still returns the
   * base set (+`other`), so `entityType` is an enforced enum even on an
   * un-profiled, un-classified run.
   */
  private resolveAllowedTypes(
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary
  ): string[] | undefined {
    // Open-predicate: no enum at all → buildGraphSchema falls to free `z.string()`.
    if (this.openPredicate) return undefined;
    // Strict: a supplied glossary REPLACES the base/domain sets (exact ontology).
    if (this.strictVocabulary && glossary?.entityTypes?.length) {
      return Array.from(new Set([...glossary.entityTypes, ENTITY_TYPE_ESCAPE]));
    }
    return allowedEntityTypes(contentClasses, glossary?.entityTypes ?? []);
  }

  /**
   * Scope the relation-predicate enum: the active domain's `primaryRelationTypes`
   * ∪ corpus-glossary relation types ∪ base set ∪ `related_to`. Delegates to the
   * shared {@link allowedRelationTypes}. Unlike the pre-Phase-2 resolver this
   * passes `contentClasses`, so the domain predicates the hints/examples teach are
   * actually emittable (KG-05) instead of triggering ZodError → empty graph.
   */
  private resolveAllowedRelationTypes(
    contentClasses?: ClassificationResult[],
    glossary?: CorpusGlossary
  ): string[] | undefined {
    // Open-predicate: no enum at all → buildGraphSchema falls to free `z.string()`.
    if (this.openPredicate) return undefined;
    // Strict: a supplied glossary REPLACES the base/domain sets (exact ontology).
    if (this.strictVocabulary && glossary?.relationTypes?.length) {
      return Array.from(new Set([...glossary.relationTypes, RELATION_TYPE_ESCAPE]));
    }
    return allowedRelationTypes(contentClasses, glossary?.relationTypes ?? []);
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
      sourceAdapter: chunk.provenance?.sourceAdapter,
      locator: chunk.provenance?.locator,
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
            ...(provenance.sourceAdapter ? { sourceAdapter: provenance.sourceAdapter } : {}),
            ...(provenance.locator ? { locator: provenance.locator } : {}),
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
   * Inline grounding gate (Phase 5): check each observation fact AND each
   * relation triple against its source chunk via the injected checker (keyword
   * overlap | MiniCheck NLI), then either flag (annotate, keep) or drop the
   * ungrounded ones. No-op when disabled. Every rejection is recorded
   * (`groundingRejections`) so it leaves a trace in the run manifest (WI3).
   */
  private async applyGroundingGate(
    kg: KnowledgeGraph,
    source: string,
    filePath: string,
    chunkIndex: number,
    extractionId?: string
  ): Promise<KnowledgeGraph> {
    if (this.grounding === 'disabled' || !source) return kg;
    const drop = this.grounding === 'drop';
    let droppedObs = 0;
    let droppedRel = 0;

    // Observations — the claim is the fact text.
    for (const e of kg.entities) {
      const kept: Observation[] = [];
      for (const o of e.observations) {
        const v = await this.groundingChecker.check(o.text, source);
        const decision = v.supported ? 'accept' : drop ? 'drop' : 'flag';
        if (trace.enabled && extractionId) {
          this.traceGrounding(extractionId, 'observation', e.name, o.text, v.score, decision,
            LineageRegistry.observationId(extractionId, e.name, o.text));
        }
        if (v.supported) {
          if (!drop) {
            o.groundingScore = v.score;
            o.grounded = true;
          }
          kept.push(o);
          continue;
        }
        this.recordRejection(filePath, chunkIndex, 'observation', e.name, o.text, v.score, drop);
        if (drop) {
          droppedObs++;
        } else {
          o.groundingScore = v.score;
          o.grounded = false;
          kept.push(o);
        }
      }
      e.observations = kept;
    }

    // Relation triples — verbalize `{from} {predicate} {to}` and check it.
    const keptRel: typeof kg.relations = [];
    for (const r of kg.relations) {
      const claim = verbalizeRelation(r.from, r.relationType, r.to);
      // Pass the edge endpoints so a checker's keyword pre-filter can require both
      // are actually present in the source (a predicate-only overlap mustn't pass).
      const v = await this.groundingChecker.check(claim, source, [r.from, r.to]);
      const decision = v.supported ? 'accept' : drop ? 'drop' : 'flag';
      if (trace.enabled && extractionId) {
        this.traceGrounding(extractionId, 'relation', `${r.from}→${r.to}`, claim, v.score, decision,
          LineageRegistry.relationMentionId(extractionId, r.from, r.to));
      }
      if (v.supported) {
        if (!drop) {
          r.groundingScore = v.score;
          r.grounded = true;
        }
        keptRel.push(r);
        continue;
      }
      this.recordRejection(filePath, chunkIndex, 'relation', `${r.from}→${r.to}`, claim, v.score, drop);
      if (drop) {
        droppedRel++;
      } else {
        r.groundingScore = v.score;
        r.grounded = false;
        keptRel.push(r);
      }
    }
    kg.relations = keptRel;

    if (droppedObs > 0 || droppedRel > 0) {
      this.logger.debug(
        `Grounding gate dropped ${droppedObs} observation(s) and ${droppedRel} relation(s) ` +
          `in ${filePath} [chunk ${chunkIndex}]`
      );
    }
    return kg;
  }

  /** Record one grounding rejection for the run manifest (WI3). */
  private recordRejection(
    filePath: string,
    chunkIndex: number,
    kind: GroundingRejection['kind'],
    subject: string,
    claim: string,
    score: number,
    dropped: boolean
  ): void {
    this.groundingRejections.push({ filePath, chunkIndex, kind, subject, claim, score, dropped });
  }

  /**
   * Debug trace: register each parsed entity/observation/relation's deterministic
   * mention ID in the run lineage and emit the extraction event. Mention IDs are
   * derived from content (never stored on the graph) so this is pure observation.
   */
  private traceExtraction(
    kg: KnowledgeGraph,
    ctx: { extractionId: string; chunkId: string; filePath: string; chunkIndex: number; checkpointHit: boolean; usage?: LLMUsage; failed?: boolean; error?: string }
  ): void {
    if (!trace.enabled) return;
    const entityMentions = kg.entities.map((e) => {
      const observationIds = e.observations.map((o) =>
        LineageRegistry.observationId(ctx.extractionId, e.name, obsText(o))
      );
      const mentionId = LineageRegistry.entityMentionId(ctx.extractionId, e.name);
      trace.lineage.registerEntity({
        mentionId, name: e.name, entityType: e.entityType,
        chunkId: ctx.chunkId, extractionId: ctx.extractionId, observationIds,
      });
      return { mentionId, name: e.name, entityType: e.entityType, observationIds };
    });
    const relationMentions = kg.relations.map((r) => ({
      mentionId: LineageRegistry.relationMentionId(ctx.extractionId, r.from, r.to),
      from: r.from, to: r.to, relationType: r.relationType,
    }));
    trace.emit({
      stage: 'extract', type: 'extraction',
      extractionId: ctx.extractionId, chunkId: ctx.chunkId, file: ctx.filePath, chunkIndex: ctx.chunkIndex,
      model: this.model, promptVersion: this.promptVersion,
      checkpointHit: ctx.checkpointHit, entityMentions, relationMentions,
      ...(ctx.usage ? { usage: ctx.usage } : {}),
      ...(ctx.failed ? { failed: true } : {}),
      ...(ctx.error ? { error: ctx.error } : {}),
    });
  }

  /** Debug trace: emit one grounding decision (accept/flag/drop) for a claim. */
  private traceGrounding(
    extractionId: string,
    kind: 'observation' | 'relation',
    subject: string,
    claim: string,
    score: number,
    decision: 'accept' | 'flag' | 'drop',
    mentionId: string
  ): void {
    trace.emit({
      stage: 'ground', type: 'grounding',
      extractionId, chunkId: extractionId.split('@')[0], mentionId,
      kind, subject, claim, score,
      checker: (this.groundingChecker as any)?.constructor?.name ?? 'grounding',
      decision,
    });
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
      corpusGlossary: glossary,
      strictVocabulary: this.strictVocabulary
    });

    return this.generateKnowledgeGraph(
      systemPrompt,
      userPrompt,
      images,
      this.resolveAllowedTypes(contentClasses, glossary),
      this.resolveAllowedRelationTypes(contentClasses, glossary)
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
      corpusGlossary: glossary,
      strictVocabulary: this.strictVocabulary
    });

    return this.generateKnowledgeGraph(
      systemPrompt,
      userPrompt,
      images,
      this.resolveAllowedTypes(contentClasses, glossary),
      this.resolveAllowedRelationTypes(contentClasses, glossary)
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

    // Let failures propagate (generateStructured already retries 3× then throws).
    // buildChunk catches, records the failed chunk, and skips its checkpoint so
    // --resume retries it — do NOT swallow into an empty graph here (KG-02).
    const result = await this.llmService.generateStructured<RawGraph>(
      messages,
      buildGraphSchema(allowedTypes, allowedRelationTypes) as unknown as z.ZodType<RawGraph>
    );

    // Ensure arrays exist
    result.entities ??= [];
    result.relations ??= [];

    this.logger.debug(`Generated KG with ${result.entities.length} entities and ${result.relations.length} relations`);

    return result;
  }
}