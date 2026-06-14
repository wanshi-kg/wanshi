import { Logger } from "../../shared";
import { ProcessingOptions } from "../../types";
import {
  ILLMProvider,
  IPromptManager,
  IKnowledgeGraphMerger,
  IProgressEmitter,
  IGroundingChecker,
  IContradictionChecker,
} from "../../types";
import { DIContainer } from "./DIContainer";
import { EmbeddingService } from "../llm";
import { FileReaderFactory, TextChunker } from "../processor";
import type { CheckpointService } from "../checkpoint";
import { IContentClassifier } from "../processor/classifier";
import { LlmContentClassifier } from "../processor/classifier/LlmContentClassifier";

/**
 * Service identifiers for dependency injection
 */
export const TYPES = {
  Logger: Symbol.for("Logger"),
  LLMService: Symbol.for("LLMService"),
  EmbeddingService: Symbol.for("EmbeddingService"),
  PromptManager: Symbol.for("PromptManager"),
  FileDiscoveryService: Symbol.for("FileDiscoveryService"),
  FileReaderFactory: Symbol.for("FileReaderFactory"),
  FileProcessor: Symbol.for("FileProcessor"),
  ContentClassifier: Symbol.for("ContentClassifier"),
  TextChunker: Symbol.for("TextChunker"),
  KnowledgeGraphBuilder: Symbol.for("KnowledgeGraphBuilder"),
  KnowledgeGraphSearch: Symbol.for("KnowledgeGraphSearch"),
  KnowledgeGraphMerger: Symbol.for("KnowledgeGraphMerger"),
  DirectoryProcessor: Symbol.for("DirectoryProcessor"),
  KnowledgeGraphExportService: Symbol.for("KnowledgeGraphExportService"),
  ProcessingOptions: Symbol.for("ProcessingOptions"),
  CheckpointService: Symbol.for("CheckpointService"),
  ProgressEmitter: Symbol.for("ProgressEmitter"),
  CorpusAnalyzer: Symbol.for("CorpusAnalyzer"),
  AstSeedService: Symbol.for("AstSeedService"),
};

/**
 * Factory function type for creating services
 */
export type ServiceFactory<T> = (container: DIContainer) => T | Promise<T>;

/**
 * Service registration with lifecycle management
 */
export interface ServiceRegistration<T = any> {
  factory: ServiceFactory<T>;
  singleton: boolean;
  instance?: T;
}

/**
 * Configuration for the DI container
 */
export interface ContainerConfig {
  processingOptions?: Partial<ProcessingOptions>;
}

/**
 * Factory for creating configured DI containers
 */
export class ContainerFactory {
  /**
   * Create a fully configured container
   */
  static createContainer(config: ContainerConfig): DIContainer {
    const container = new DIContainer();

    // Register configuration
    container.registerValue<ProcessingOptions>(
      TYPES.ProcessingOptions,
      config.processingOptions as ProcessingOptions
    );

    // Register logger
    container.register(TYPES.Logger, async (c) => {
      const { LoggerFactory } = await import("../../shared/logger");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );

      return LoggerFactory.createLogger(options);
    });

    // Register progress emitter. NDJSON-on-stdout when --progress-ndjson is set
    // (for a parent process / UI), otherwise a no-op so the normal path is
    // unaffected.
    container.register(TYPES.ProgressEmitter, async (c) => {
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const { NoopProgressEmitter, NdjsonProgressEmitter } = await import(
        "../progress"
      );
      return options.logging.progressNdjson
        ? new NdjsonProgressEmitter(process.stdout)
        : new NoopProgressEmitter();
    });

    // Register LLM services (provider-selectable: local Ollama or OpenAI-compatible)
    container.register(TYPES.LLMService, async (c) => {
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const llmOptions = {
        model: options.llm.model,
        host: options.llm.host,
        apiKey: options.llm.apiKey,
        images: options.readers.images !== "disabled",
        temperature: options.llm.temperature,
        contextLength: options.llm.contextLength,
        repeatPenalty: options.llm.repeatPenalty,
        seed: options.llm.seed,
        maxTokens: options.llm.maxTokens,
      };

      if (options.llm.provider === "openai") {
        const { OpenAICompatibleService } = await import(
          "../llm/OpenAICompatibleService"
        );
        logger.info(`Using OpenAI-compatible provider at ${options.llm.host}`);
        return new OpenAICompatibleService(llmOptions, logger);
      }

      const { OllamaService } = await import("../llm/OllamaService");
      return new OllamaService(llmOptions, logger);
    });

    // Register Embedding service (independent provider from generation)
    container.register(TYPES.EmbeddingService, async (c) => {
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const embeddingsModel = options.embeddings.model;
      const embeddingsHost = options.embeddings.host;

      if (options.embeddings.provider === "openai") {
        const { OpenAIEmbeddingService } = await import(
          "../llm/OpenAIEmbeddingService"
        );
        logger.info(
          `Using OpenAI-compatible embeddings provider at ${embeddingsHost}`
        );
        return new OpenAIEmbeddingService(
          {
            model: embeddingsModel,
            host: embeddingsHost,
            apiKey: options.embeddings.apiKey,
            maxInputChars: options.embeddings.maxInputChars,
          },
          logger
        );
      }

      const { EmbeddingService } = await import("../llm/EmbeddingService");
      return new EmbeddingService(
        {
          model: embeddingsModel,
          host: embeddingsHost,
          maxInputChars: options.embeddings.maxInputChars,
        },
        logger
      );
    });

    // Register Prompt Manager
    container.register(TYPES.PromptManager, async (c) => {
      const { PromptManager } = await import("../llm/prompts/PromptManager");
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const manager = new PromptManager(logger, undefined, config.processingOptions?.readers?.outline);

      const options = config.processingOptions;
      if (options?.llm?.promptVersion) {
        manager.setPromptVersion(options.llm.promptVersion);
      }
      if (options?.llm?.system) {
        manager.setCustomSystemPrompt(options.llm.system);
      }

      return manager;
    });

    container.register(TYPES.FileDiscoveryService, async (c) => {
      const { FileDiscoveryService } = await import("..");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);

      return new FileDiscoveryService(options, logger);
    });

    container.register(TYPES.TextChunker, async (c) => {
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      return new TextChunker(
        {
          enabled: options.chunking.mode !== "disabled",
          maxChunkSize: options.chunking.size,
          overlapSize: options.chunking.overlap,
        },
        logger
      );
    });

    // Register File REader Factory
    container.register(TYPES.FileReaderFactory, async (c) => {
      const {
        FileReaderFactory,
        AudioReader,
        BinaryReader,
        MarkdownReader,
        DoclingReader,
        HtmlReader,
        ImageReader,
        JsonFileReader,
        OfficeReader,
        TextReader,
        TranscriptReader,
        PdfReader,
        RtfReader
      } = await import(
        "../processor/readers"
      );
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const chunker = await c.resolve<TextChunker>(TYPES.TextChunker);
      const factory = new FileReaderFactory(logger);

      if (options.readers.docling) {
        logger.info(`Using docling document reading pipeline`);
        factory.registerReader(
          new DoclingReader(undefined, undefined, undefined, "./temp", chunker, logger)
        );
      } else {
        const refLinks = options.references.internalLinks.enabled;
        const refCites = options.references.citations.enabled;
        factory.registerReader(new RtfReader(chunker, logger));
        factory.registerReader(
          new MarkdownReader(chunker, logger, options.readers.stripReferences, refLinks, refCites)
        );
        factory.registerReader(new HtmlReader(chunker, logger, refLinks));
        factory.registerReader(new ImageReader(chunker, logger));
        factory.registerReader(new OfficeReader(chunker, logger));
        factory.registerReader(
          new PdfReader(chunker, logger, options.readers.stripReferences, refCites)
        );
      }

      // Transcript reader claims speaker-labeled text (.parakeet.txt, …) and
      // transcript-shaped JSON (recua turns / chat exports). Registered before
      // JsonFileReader and TextReader (first-match-wins) so it wins for those;
      // its content-sniffing canRead defers everything else.
      factory.registerReader(
        new TranscriptReader(chunker, logger, options.chunking.size)
      );

      // JSON reader claims .json/.jsonl/.geojson — must be registered before
      // TextReader (first-match-wins) so it handles them instead of TextReader.
      factory.registerReader(
        new JsonFileReader(
          {
            strategy: options.readers.json.strategy,
            maxChunkSize: options.readers.json.maxChunkSize ?? options.chunking.size,
          },
          chunker,
          logger
        )
      );

      // ASR audio reader before TextReader so audio never falls through to text;
      // only registered when ASR is enabled (otherwise audio routes to the
      // BinaryReader catch-all below and is skipped gracefully).
      if (options.readers.asr.mode !== "disabled") {
        logger.info(`Using automatic speech recognition pipeline`);
        factory.registerReader(
          new AudioReader(
            {
              modelName: options.readers.asr.whisperModel,
              language: options.readers.asr.language,
              translate: options.readers.asr.translate,
            },
            "./temp",
            chunker,
            logger
          )
        );
      }

      factory.registerReader(new TextReader(chunker, logger));

      // Final catch-all: claims anything no specific reader recognized and skips
      // it gracefully (no UTF-8 mojibake, no LLM call). MUST be registered last.
      factory.registerReader(new BinaryReader(chunker, logger));

      return factory;
    });

    // Register Content Classifier
    container.register<IContentClassifier | undefined>(TYPES.ContentClassifier, async (c) => {
      const {
        HeuristicContentClassifier,
      } = await import("../processor/classifier");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      switch (options.classifier.mode) {
        case "bert":
          // Not implemented — fail clearly at wiring time rather than throwing
          // partway through a run. The CLI also rejects this earlier.
          throw new Error(
            "The 'bert' classifier is not implemented. Use --classifier heuristic|llm, or disabled."
          );
        case "heuristic": return new HeuristicContentClassifier(logger);
        case "llm": {
          // Share the selected generation provider (KG-15) so --classifier llm
          // works on cloud (OpenAI-compatible) backends, not just local Ollama.
          const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
          return new LlmContentClassifier(llm, logger);
        }
        default: return undefined;
      }
    });

    // Register File Processor
    container.register(TYPES.FileProcessor, async (c) => {
      const { FileProcessor } = await import("../processor");
      const factory = await c.resolve<FileReaderFactory>(
        TYPES.FileReaderFactory
      );
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const classifier = await c.resolve<IContentClassifier | undefined>(
        TYPES.ContentClassifier
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      return new FileProcessor(factory, classifier, options.readers.images !== "disabled", logger);
    });

    // Register Corpus Analyzer (used only when --corpus-profiling is enabled)
    container.register(TYPES.CorpusAnalyzer, async (c) => {
      const { CorpusAnalyzer } = await import("../corpus");
      const llmService = await c.resolve<ILLMProvider>(TYPES.LLMService);
      const classifier = await c.resolve<IContentClassifier | undefined>(
        TYPES.ContentClassifier
      );
      const factory = await c.resolve<FileReaderFactory>(
        TYPES.FileReaderFactory
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const promptManager = await c.resolve<IPromptManager>(TYPES.PromptManager);
      return new CorpusAnalyzer(llmService, classifier, factory, logger, promptManager);
    });

    // Register the AST symbol seed service (Phase 8; used when ast.mode=enabled)
    container.register(TYPES.AstSeedService, async (c) => {
      const { AstSeedService, AstSymbolStore } = await import("../processor/ast");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const cachePath = options.ast.cachePath || `${options.output}.ast-cache.json`;
      const store = new AstSymbolStore(cachePath, logger);
      return new AstSeedService(store, logger, options.input);
    });

    // Register Checkpoint service (used only when --resume is set)
    container.register(TYPES.CheckpointService, async (c) => {
      const { CheckpointService } = await import("../checkpoint");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const checkpointPath =
        options.resume.checkpointPath || `${options.output}.checkpoint.jsonl`;
      const service = new CheckpointService(checkpointPath, logger, {
        model: options.llm.model,
        promptVersion: options.llm.promptVersion,
      });
      if (options.resume.enabled) {
        await service.load();
      }
      return service;
    });

    // Register Knowledge Graph Builder
    container.register(TYPES.KnowledgeGraphBuilder, async (c) => {
      const { KnowledgeGraphBuilder } = await import(
        "../knowledge/KnowledgeGraphBuilder"
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const llmService = await c.resolve<ILLMProvider>(TYPES.LLMService);
      const promptManager = await c.resolve<IPromptManager>(
        TYPES.PromptManager
      );
      const checkpoint = await c.resolve<CheckpointService>(
        TYPES.CheckpointService
      );
      const progress = await c.resolve<IProgressEmitter>(
        TYPES.ProgressEmitter
      );

      // Inline grounding checker: minicheck (local NLI, with keyword pre-filter)
      // when selected & active; otherwise the builder defaults to the keyword
      // checker. The grounding signature is folded into the checkpoint key so
      // toggling the gate between --resume runs re-extracts affected chunks
      // (disabled ⇒ empty signature == legacy key, preserving old checkpoints).
      const g = options.grounding;
      const groundingSignature =
        g.mode === "disabled" ? "" : `${g.mode}|${g.checker}|${g.minScore}|${g.model}`;
      let groundingChecker: IGroundingChecker | undefined;
      if (g.mode !== "disabled" && g.checker === "minicheck") {
        const { MiniCheckGroundingChecker } = await import(
          "../knowledge/grounding"
        );
        groundingChecker = new MiniCheckGroundingChecker(
          { model: g.model, host: g.host, min: g.minScore, escalateAbove: g.escalateAbove },
          logger
        );
      }

      return new KnowledgeGraphBuilder(
        {
          llmService,
          promptManager: promptManager as any,
          checkpoint,
          resume: options.resume.enabled,
          model: options.llm.model,
          promptVersion: options.llm.promptVersion,
          inputRoot: options.input,
          progress,
          grounding: options.grounding.mode,
          groundingMinScore: options.grounding.minScore,
          groundingChecker,
          groundingSignature,
          // Stamp edge source spans only when the pipeline grounding gate needs
          // them, so the baseline graph stays free of the extra weight.
          attachSourceSpans: options.pipeline.grounding.enabled,
        },
        logger
      );
    });

    // Register Knowledge Graph Search
    container.register(TYPES.KnowledgeGraphSearch, async (c) => {
      const { KnowledgeGraphSearch } = await import("../knowledge");
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const embeddingService = await c.resolve<EmbeddingService>(
        TYPES.EmbeddingService
      );

      return new KnowledgeGraphSearch(embeddingService, logger);
    });

    // Register Knowledge Graph Merger
    container.register(TYPES.KnowledgeGraphMerger, async (c) => {
      const { mergeKnowledgeGraphs } = await import("../knowledge");
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const embeddingService = await c.resolve<EmbeddingService>(
        TYPES.EmbeddingService
      );

      // Merge-time supersession checker (KG-10): heuristic (cheap, default off) or
      // LLM-backed; off ⇒ no supersession. The LLM checker reuses the generation
      // provider (resolved lazily so a heuristic/disabled run needs no LLM).
      let contradictionChecker: IContradictionChecker | undefined;
      if (options.merging.supersession === "heuristic") {
        const { HeuristicContradictionChecker } = await import(
          "../knowledge/contradiction"
        );
        contradictionChecker = new HeuristicContradictionChecker();
      } else if (options.merging.supersession === "llm") {
        const { LlmContradictionChecker } = await import("../knowledge/contradiction");
        const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
        contradictionChecker = new LlmContradictionChecker(llm, logger);
      }

      // Return a wrapper that implements the interface
      return {
        merge: async (graphs) => {
          const records: import("../knowledge/MergeRecord").MergeRecord[] = [];
          const result = await mergeKnowledgeGraphs(
            graphs,
            {
              entitySimilarityThreshold: options.merging.entitySimilarityThreshold,
              observationSimilarityThreshold:
                options.merging.observationSimilarityThreshold,
              enableSimilarityMerging: options.merging.enableSimilarityMerging,
              contradictionChecker,
              onMergeRecord: options.inspection.emitMergeLog
                ? (r) => records.push(r)
                : undefined,
            },
            embeddingService,
            logger
          );

          // String-merge fusions land next to the canon merge log (same JSONL shape,
          // readable by `wanshi inspect-merges`).
          if (options.inspection.emitMergeLog && records.length > 0) {
            const path = await import("path");
            const fs = await import("fs");
            const base =
              options.inspection.mergeLogPath ??
              path.join("runs", new Date().toISOString().replace(/[:.]/g, "-"), "merges.jsonl");
            const logPath = path.join(path.dirname(base), "string-merges.jsonl");
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
            logger.info(`String-merge log written to ${logPath} (${records.length} fusion(s))`);
          }

          return result;
        },
      } as IKnowledgeGraphMerger;
    });

    // Register Knowledge Graph Export Service
    container.register(TYPES.KnowledgeGraphExportService, async () => {
      const {
        JsonExportStrategy,
        JsonlExportStrategy,
        McpExportStrategy,
        GraphvizDotExportStrategy,
        KblamExportStrategy,
        LoraExportStrategy,
        GraphitiExportStrategy,
      } = await import("../export/strategies");
      const { KnowledgeGraphExportService } = await import(
        "../export/KnowledgeGraphExportService"
      );

      return new KnowledgeGraphExportService(
        new JsonExportStrategy(),
        new JsonlExportStrategy(),
        new McpExportStrategy(),
        new GraphvizDotExportStrategy(),
        new KblamExportStrategy(),
        new LoraExportStrategy(),
        new GraphitiExportStrategy()
      );
    });

    // Register Directory Processor (depends on all other services)
    container.register(TYPES.DirectoryProcessor, async (c) => {
      const { DirectoryProcessor } = await import("../DirectoryProcessor");
      return new DirectoryProcessor(c);
    });

    return container;
  }
}
