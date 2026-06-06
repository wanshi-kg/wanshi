import { Logger } from "../../shared";
import { ProcessingOptions } from "../../types";
import {
  ILLMProvider,
  IPromptManager,
  IKnowledgeGraphMerger,
  IProgressEmitter,
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
      return options.progressNdjson
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
        model: options.model,
        host: options.host,
        apiKey: options.apiKey,
        images: options.images !== "disabled",
        temperature: options.temperature,
        contextLength: options.contextLength,
        repeatPenalty: options.repeatPenalty,
        seed: options.seed,
        maxTokens: options.maxTokens ? Number(options.maxTokens) : undefined,
      };

      if (options.provider === "openai") {
        const { OpenAICompatibleService } = await import(
          "../llm/OpenAICompatibleService"
        );
        logger.info(`Using OpenAI-compatible provider at ${options.host}`);
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

      const embeddingsModel =
        options.embeddingsModel || "mxbai-embed-large:335m";
      const embeddingsHost =
        options.embeddingsHost || "http://localhost:11434";

      if (options.embeddingsProvider === "openai") {
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
            apiKey: options.embeddingsApiKey,
            maxInputChars: options.embeddingsMaxInputChars
              ? Number(options.embeddingsMaxInputChars)
              : undefined,
          },
          logger
        );
      }

      const { EmbeddingService } = await import("../llm/EmbeddingService");
      return new EmbeddingService(
        {
          model: embeddingsModel,
          host: embeddingsHost,
          maxInputChars: options.embeddingsMaxInputChars,
        },
        logger
      );
    });

    // Register Prompt Manager
    container.register(TYPES.PromptManager, async (c) => {
      const { PromptManager } = await import("../llm/prompts/PromptManager");
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const manager = new PromptManager(logger, undefined, config.processingOptions?.outline);

      const options = config.processingOptions;
      if (options?.promptVersion) {
        manager.setPromptVersion(options.promptVersion);
      }
      if (options?.system) {
        manager.setCustomSystemPrompt(options.system);
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
          enabled: options.chunking !== "disabled",
          maxChunkSize: options.chunkSize || 2000,
          overlapSize: options.overlapSize || 100,
        },
        logger
      );
    });

    // Register File REader Factory
    container.register(TYPES.FileReaderFactory, async (c) => {
      const {
        FileReaderFactory,
        AudioReader,
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

      if (options.docling) {
        logger.info(`Using docling document reading pipeline`);
        factory.registerReader(
          new DoclingReader(undefined, undefined, undefined, "./temp", chunker, logger)
        );
      } else {
        factory.registerReader(new RtfReader(chunker, logger));
        factory.registerReader(new MarkdownReader(chunker, logger));
        factory.registerReader(new HtmlReader(chunker, logger));
        factory.registerReader(new ImageReader(chunker, logger));
        factory.registerReader(new OfficeReader(chunker, logger));
        factory.registerReader(new PdfReader(chunker, logger));
      }

      // Transcript reader claims speaker-labeled text (.parakeet.txt, …) and
      // transcript-shaped JSON (recua turns / chat exports). Registered before
      // JsonFileReader and TextReader (first-match-wins) so it wins for those;
      // its content-sniffing canRead defers everything else.
      factory.registerReader(
        new TranscriptReader(chunker, logger, Number(options.chunkSize) || 4000)
      );

      // JSON reader claims .json/.jsonl/.geojson — must be registered before
      // TextReader (first-match-wins) so it handles them instead of TextReader.
      factory.registerReader(
        new JsonFileReader(
          {
            strategy: options.jsonReader?.strategy ?? options.jsonStrategy,
            maxChunkSize:
              options.jsonReader?.maxChunkSize ?? Number(options.chunkSize) ?? undefined,
          },
          chunker,
          logger
        )
      );

      factory.registerReader(new TextReader(chunker, logger));

      if (options.asr !== "disabled") {
        logger.info(`Using automatic speech recognition pipeline`);
        factory.registerReader(
          new AudioReader(
            {
              modelName: options.whisperModel,
              language: options.language,
              translate: options.translate,
            },
            "./temp",
            chunker, 
            logger
          )
        );
      }

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
      switch (options.classifier) {
        case "bert":
          // Not implemented — fail clearly at wiring time rather than throwing
          // partway through a run. The CLI also rejects this earlier.
          throw new Error(
            "The 'bert' classifier is not implemented. Use --classifier heuristic|llm, or disabled."
          );
        case "heuristic": return new HeuristicContentClassifier(logger);
        case "llm": return new LlmContentClassifier(logger, { model: options.model, host: options.host });
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
      return new FileProcessor(factory, classifier, options.images !== "disabled", logger);
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
      return new CorpusAnalyzer(llmService, classifier, factory, logger);
    });

    // Register Checkpoint service (used only when --resume is set)
    container.register(TYPES.CheckpointService, async (c) => {
      const { CheckpointService } = await import("../checkpoint");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);

      const checkpointPath =
        options.checkpointPath || `${options.output}.checkpoint.jsonl`;
      const service = new CheckpointService(checkpointPath, logger, {
        model: options.model,
        promptVersion: options.promptVersion ?? "default",
      });
      if (options.resume) {
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

      return new KnowledgeGraphBuilder(
        {
          llmService,
          promptManager: promptManager as any,
          checkpoint,
          resume: options.resume,
          model: options.model,
          promptVersion: options.promptVersion,
          inputRoot: options.input,
          progress,
          grounding: options.grounding,
          groundingMinScore: options.groundingMinScore
            ? Number(options.groundingMinScore)
            : undefined,
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

      // Return a wrapper that implements the interface
      return {
        merge: async (graphs) => {
          return await mergeKnowledgeGraphs(
            graphs,
            {
              entitySimilarityThreshold: options.entitySimilarityThreshold,
              observationSimilarityThreshold:
                options.observationSimilarityThreshold,
            },
            embeddingService,
            logger
          );
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
