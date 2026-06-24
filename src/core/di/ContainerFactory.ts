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
import { ObjectDetectionService } from "../cv/ObjectDetectionService";
import { configureDomainGate } from "../knowledge/vocabulary";
import { createHash } from "crypto";
import { trace } from "../trace";
import { meter } from "../cost";

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
  FetchCacheService: Symbol.for("FetchCacheService"),
  GatedFetcher: Symbol.for("GatedFetcher"),
  // Phase 2 — citation span-fetch
  CitationResolver: Symbol.for("CitationResolver"),
  GrobidClient: Symbol.for("GrobidClient"),
  CitationFetcher: Symbol.for("CitationFetcher"),
  CitationFetchCache: Symbol.for("CitationFetchCache"),
  StructuredAdapterRegistry: Symbol.for("StructuredAdapterRegistry"),
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

    const processingOptions = config.processingOptions as ProcessingOptions;

    // Apply run-global domain-gate thresholds (A1) before any lazy factory — the
    // enum path, prompt hints, cascade, and harness then all gate on the same
    // configured values (KG-05 single source).
    configureDomainGate({
      lowConfidence: processingOptions.classifier?.lowConfidenceThreshold,
      mixedDomain: processingOptions.classifier?.mixedDomainThreshold,
    });

    // Configure the run-global debug trace singleton (observe-only; off by default).
    // Mint a runId from time + a config digest so each run's trace is identifiable.
    const traceCfg = processingOptions.trace ?? { enabled: false };
    const runId =
      new Date().toISOString() +
      "-" +
      createHash("sha1")
        .update(`${processingOptions.output}␟${processingOptions.llm?.model}␟${processingOptions.llm?.promptVersion}`)
        .digest("hex")
        .slice(0, 8);
    trace.configure({
      enabled: !!traceCfg.enabled,
      path: traceCfg.path || (processingOptions.output ? `${processingOptions.output}.trace.jsonl` : undefined),
      runId,
    });

    // Configure the run-global cost meter singleton (off by default; logger attached
    // later in DirectoryProcessor where it's resolved). Setting maxCost auto-enables.
    const costCfg = processingOptions.cost ?? { enabled: false, currency: "USD", prices: {} };
    meter.configure({
      enabled: !!costCfg.enabled || costCfg.maxCost != null,
      maxCost: costCfg.maxCost,
      currency: costCfg.currency || "USD",
      prices: costCfg.prices ?? {},
      ledgerPath: costCfg.ledgerPath || (processingOptions.output ? `${processingOptions.output}.cost.json` : undefined),
    });

    // Register configuration
    container.registerValue<ProcessingOptions>(
      TYPES.ProcessingOptions,
      processingOptions
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

    // Structured-emit adapter registry (data-sink track). Empty by default;
    // concrete adapters (SQLite, OpenAPI, iCal, …) register here in their own briefs.
    container.register(TYPES.StructuredAdapterRegistry, async (c) => {
      const { StructuredAdapterRegistry } = await import("../adapters");
      const registry = new StructuredAdapterRegistry();
      // Concrete adapters register only when enabled (registry stays empty otherwise →
      // default run unaffected). SQLite is the first (data-sink Class A).
      const sqliteCfg = processingOptions.adapters?.sqlite;
      if (sqliteCfg?.enabled) {
        const { SqliteAdapter } = await import("../adapters/SqliteAdapter");
        const logger = await c.resolve<Logger>(TYPES.Logger);
        registry.register(
          new SqliteAdapter(
            {
              extensions: sqliteCfg.extensions,
              maxRowsPerTable: sqliteCfg.maxRowsPerTable,
              excludeTables: sqliteCfg.excludeTables,
            },
            logger
          )
        );
      }
      return registry;
    });

    // Register File REader Factory
    container.register(TYPES.FileReaderFactory, async (c) => {
      const {
        FileReaderFactory,
        AudioReader,
        BinaryReader,
        ChatExportReader,
        MarkdownReader,
        DoclingReader,
        EmailReader,
        EpubReader,
        JupyterReader,
        LatexReader,
        MarkerPdfReader,
        MistralOcrReader,
        TesseractPdfReader,
        ChandraPdfReader,
        HtmlReader,
        ImageReader,
        JsonFileReader,
        OfficeReader,
        SubtitleReader,
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

      // Reference-following and web-fetch both need links extracted, so they
      // auto-imply internalLinks extraction.
      const refLinks =
        options.references.internalLinks.enabled ||
        options.references.follow.enabled ||
        options.references.web.enabled;
      // Citation span-fetch (Phase 2) needs the bibliography extracted to know
      // what to resolve/fetch, so it auto-implies citation extraction.
      const refCites =
        options.references.citations.enabled || options.references.citations.fetch.enabled;

      // Standard non-PDF readers are always registered; the PDF slot is chosen by
      // readers.pdfEngine below (first-match-wins, so these win their own formats).
      factory.registerReader(new RtfReader(chunker, logger));
      factory.registerReader(
        new MarkdownReader(chunker, logger, options.readers.stripReferences, refLinks, refCites)
      );
      factory.registerReader(new HtmlReader(chunker, logger, refLinks));
      // CV pre-pass object detector (opt-in) — a singleton (loads the model once),
      // injected into ImageReader; undefined when disabled ⇒ no detection, no cost.
      const cvDet = options.readers.cv.detection;
      const objectDetector = cvDet.enabled
        ? new ObjectDetectionService(
            {
              mode: cvDet.mode,
              model: cvDet.model,
              threshold: cvDet.threshold,
              labels: cvDet.labels,
              maxObjects: cvDet.maxObjects,
              cacheDir: cvDet.cacheDir,
              allowRemote: cvDet.allowRemote,
            },
            logger
          )
        : undefined;
      factory.registerReader(
        new ImageReader(
          chunker,
          logger,
          {
            exif: options.readers.exif.enabled,
            c2pa: { enabled: options.readers.c2pa.enabled, command: options.readers.c2pa.command },
          },
          objectDetector
        )
      );
      factory.registerReader(new OfficeReader(chunker, logger));

      // PDF engine selector. The built-in pdf2json reader doubles as the graceful
      // fallback for the marker/mistral engines (any failure → pdf2json).
      const pdf2json = new PdfReader(
        chunker, logger, options.readers.stripReferences, refCites
      );
      switch (options.readers.pdfEngine) {
        case "docling":
          logger.info(`PDF engine: docling`);
          factory.registerReader(
            new DoclingReader(undefined, undefined, undefined, "./temp", chunker, logger, [".pdf"])
          );
          break;
        case "marker": {
          const m = options.readers.marker;
          logger.info(`PDF engine: marker${m.useLlm ? " (--use_llm)" : ""}`);
          factory.registerReader(
            new MarkerPdfReader(
              { command: m.command, useLlm: m.useLlm, forceOcr: m.forceOcr, timeoutMs: m.timeoutMs },
              { apiKey: options.llm.apiKey, host: options.llm.host, model: options.llm.model },
              pdf2json,
              "./temp",
              chunker,
              logger
            )
          );
          break;
        }
        case "mistral": {
          const mi = options.readers.mistral;
          logger.info(`PDF engine: mistral (${mi.model})`);
          factory.registerReader(
            new MistralOcrReader(
              { apiKey: mi.apiKey ?? process.env.MISTRAL_API_KEY, host: mi.host, model: mi.model, timeoutMs: mi.timeoutMs },
              pdf2json,
              chunker,
              logger
            )
          );
          break;
        }
        case "tesseract": {
          const t = options.readers.tesseract;
          logger.info(`PDF engine: tesseract (${t.lang})`);
          factory.registerReader(
            new TesseractPdfReader(
              { lang: t.lang, scale: t.scale, oem: t.oem, psm: t.psm, langPath: t.langPath },
              pdf2json,
              chunker,
              logger
            )
          );
          break;
        }
        case "chandra": {
          const ch = options.readers.chandra;
          logger.info(`PDF engine: chandra (${ch.method})`);
          factory.registerReader(
            new ChandraPdfReader(
              { command: ch.command, method: ch.method, timeoutMs: ch.timeoutMs },
              pdf2json,
              "./temp",
              chunker,
              logger
            )
          );
          break;
        }
        default:
          factory.registerReader(pdf2json);
      }

      // Transcript reader claims speaker-labeled text (.parakeet.txt, …) and
      // transcript-shaped JSON (recua turns / chat exports). Registered before
      // JsonFileReader and TextReader (first-match-wins) so it wins for those;
      // its content-sniffing canRead defers everything else.
      factory.registerReader(
        new TranscriptReader(chunker, logger, options.chunking.size)
      );

      // Email reader claims .eml/.mbox (otherwise unclaimed → skipped as binary).
      // Each message becomes a conversational turn (sender→speaker, Date→occurredAt),
      // reusing the shared transcript turn-packing. Registered before TextReader.
      factory.registerReader(
        new EmailReader(chunker, logger, options.chunking.size, options.readers.email)
      );

      // Chat-export reader sniffs chat-shaped .txt (WhatsApp) / .json (Telegram,
      // Discord, Slack) and defers everything else. Registered after Transcript
      // (Claude/ChatGPT exports stay there) and before Json/Text. Each message
      // becomes a turn (sender→speaker, timestamp→occurredAt) via packTurns.
      factory.registerReader(
        new ChatExportReader(chunker, logger, options.chunking.size, options.readers.chat)
      );

      // Class C structure-rich text (.srt/.vtt subtitles, .tex LaTeX) — both
      // currently unclaimed (→ BinaryReader). Subtitles denoise captions (+ <v>
      // turns); LaTeX cleans the body and feeds \cite{} into the reference
      // pipeline (refCites) → cites edges. Registered before Text/Binary.
      factory.registerReader(
        new SubtitleReader(chunker, logger, options.chunking.size)
      );
      factory.registerReader(new LatexReader(chunker, logger, refCites));
      // EPUB (zip→spine→chapter chunking) and Jupyter (cell-aware) — extensions
      // were unclaimed (→ BinaryReader). Registered before Text/Binary.
      factory.registerReader(
        new EpubReader(chunker, logger, options.chunking.size)
      );
      factory.registerReader(
        new JupyterReader(chunker, logger, options.readers.jupyter)
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
        const asr = options.readers.asr;
        if (asr.engine === "dual") {
          logger.info(`ASR engine: dual (vendored Python audio-pipeline at ${asr.dual.projectDir})`);
        }
        factory.registerReader(
          new AudioReader(
            {
              modelName: asr.whisperModel,
              language: asr.language,
              translate: asr.translate,
              engine: asr.engine,
              maxChunkSize: options.chunking.size,
              dual: {
                projectDir: asr.dual.projectDir,
                pythonPath: asr.dual.pythonPath,
                asr: asr.dual.asr,
                diarize: asr.dual.diarize,
                numSpeakers: asr.dual.numSpeakers,
                device: asr.dual.device,
                timeoutMs: asr.dual.timeoutMs,
              },
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
        CascadeContentClassifier,
      } = await import("../processor/classifier");
      const options = await c.resolve<ProcessingOptions>(
        TYPES.ProcessingOptions
      );
      const logger = await c.resolve<Logger>(TYPES.Logger);
      switch (options.classifier.mode) {
        case "heuristic":
          return new HeuristicContentClassifier(
            logger,
            options.classifier.temperature,
            options.classifier.crossValidationFactor
          );
        case "llm": {
          // Share the selected generation provider (KG-15) so --classifier llm
          // works on cloud (OpenAI-compatible) backends, not just local Ollama.
          const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
          return new LlmContentClassifier(llm, logger);
        }
        case "cascade": {
          // Phase-B cascade: heuristic decides the easy majority; only top-2 ties
          // escalate to the LLM (same shared provider). Degrades to heuristic-multi
          // when the budget is spent or the provider is unreachable.
          const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
          return new CascadeContentClassifier(
            new HeuristicContentClassifier(
              logger,
              options.classifier.temperature,
              options.classifier.crossValidationFactor
            ),
            new LlmContentClassifier(llm, logger),
            logger,
            options.classifier.maxEscalations
          );
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

    // Register the web reference fetch cache + gated fetcher (Phase 1; used only
    // when references.web.enabled). Network layer is never constructed otherwise.
    container.register(TYPES.FetchCacheService, async (c) => {
      const { FetchCacheService } = await import("../knowledge/references/web/FetchCacheService");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const cachePath = options.references.web.cachePath || `${options.output}.fetch-cache.jsonl`;
      const cache = new FetchCacheService(cachePath, logger);
      await cache.load();
      return cache;
    });

    container.register(TYPES.GatedFetcher, async (c) => {
      const { GatedFetcher } = await import("../knowledge/references/web/GatedFetcher");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
      const w = options.references.web;
      return new GatedFetcher(
        {
          allowlist: w.allowlist,
          rejectlist: w.rejectlist,
          maxFetches: w.maxFetches,
          timeoutMs: w.timeoutMs,
          maxBytes: w.maxBytes,
          relevanceCheck: w.relevanceCheck,
          robots: w.robots,
        },
        llm,
        logger
      );
    });

    // Phase 2 — citation span-fetch services. Constructed only when
    // references.citations.fetch.enabled; a default run never builds them.
    container.register(TYPES.CitationFetchCache, async (c) => {
      const { FetchCacheService } = await import("../knowledge/references/web/FetchCacheService");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const cachePath =
        options.references.citations.fetch.cachePath || `${options.output}.citation-cache.jsonl`;
      const cache = new FetchCacheService(cachePath, logger);
      await cache.load();
      return cache;
    });

    container.register(TYPES.CitationFetcher, async (c) => {
      const { GatedFetcher } = await import("../knowledge/references/web/GatedFetcher");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const llm = await c.resolve<ILLMProvider>(TYPES.LLMService);
      const f = options.references.citations.fetch;
      return new GatedFetcher(
        {
          allowlist: f.allowlist,
          rejectlist: f.rejectlist,
          maxFetches: f.maxFetches,
          timeoutMs: f.timeoutMs,
          maxBytes: f.maxBytes,
          relevanceCheck: false, // OA full text — the allowlist is the gate
          robots: true,
          allowPdf: true,
        },
        llm,
        logger
      );
    });

    container.register(TYPES.CitationResolver, async (c) => {
      const { CitationResolver } = await import("../knowledge/references/citations/CitationResolver");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      const cfg = options.references.citations;
      let titleResolver = null;
      if (cfg.titleResolver.enabled) {
        const { TitleIdResolver } = await import("../knowledge/references/citations/TitleIdResolver");
        const t = cfg.titleResolver;
        titleResolver = new TitleIdResolver(
          {
            mailto: t.mailto,
            openAlexKey: t.openAlexKey,
            semanticScholarKey: t.semanticScholarKey,
            minTitleSimilarity: t.minTitleSimilarity,
          },
          logger
        );
      }
      const unpaywallEmail = cfg.fetch.unpaywallEmail || process.env.UNPAYWALL_EMAIL;
      return new CitationResolver({ unpaywallEmail }, logger, titleResolver);
    });

    container.register(TYPES.GrobidClient, async (c) => {
      const { GrobidClient } = await import("../knowledge/references/citations/GrobidClient");
      const options = await c.resolve<ProcessingOptions>(TYPES.ProcessingOptions);
      const logger = await c.resolve<Logger>(TYPES.Logger);
      return new GrobidClient(options.references.citations.grobid.url, logger);
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
          // Free-vocabulary extraction (canonicalization-tax measurement): drops the
          // closed entity/relation enum so the model emits any predicate/type.
          openPredicate: options.pipeline.extraction.openPredicate,
          // Strict closed vocabulary: a supplied glossary REPLACES (not augments) the
          // base/domain vocab — feed a known ontology as the authoritative schema.
          strictVocabulary: options.pipeline.extraction.strictVocabulary,
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
          const wantMergeLog = options.inspection.emitMergeLog;
          // The merge-log seam doubles as the trace merge-decision source: fold each
          // non-canonical surface form's mentions onto the winner (lineage thread)
          // and emit one merge_decision event per fusion.
          const onMergeRecord =
            wantMergeLog || trace.enabled
              ? (r: import("../knowledge/MergeRecord").MergeRecord) => {
                  if (wantMergeLog) records.push(r);
                  if (trace.enabled) {
                    const foldedMentionIds: string[] = [];
                    for (const sf of r.surface_forms) {
                      if (sf === r.canonical_chosen) continue;
                      foldedMentionIds.push(
                        ...trace.lineage.fold(sf, r.canonical_chosen).map((m) => m.mentionId)
                      );
                    }
                    trace.emit({
                      stage: "merge",
                      type: "merge_decision",
                      mergeDecisionId: r.cluster_id,
                      target: r.target,
                      canonical: r.canonical_chosen,
                      surfaceForms: r.surface_forms,
                      foldedMentionIds,
                      cosine: r.intra_cluster_sim?.max,
                      method: r.method,
                      verdict: "accept",
                    });
                  }
                }
              : undefined;
          const result = await mergeKnowledgeGraphs(
            graphs,
            {
              entitySimilarityThreshold: options.merging.entitySimilarityThreshold,
              observationSimilarityThreshold:
                options.merging.observationSimilarityThreshold,
              enableSimilarityMerging: options.merging.enableSimilarityMerging,
              contradictionChecker,
              onMergeRecord,
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
