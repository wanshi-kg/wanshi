#! /usr/bin/env node

import { Command } from "commander";
import * as info from "../../package.json";
import { processCommand, watchCommand, exportCommand } from "./commands";
import { ProcessingOptions } from "../types/ProcessingOptions";
import { ContainerFactory, TYPES } from "../core/di";
import { readConfigurationFile, Logger, LoggerFactory } from "../shared";

const program = new Command();

program
  .name(info.name)
  .description(info.description)

  .option("--config <file>", "path to yaml/json configuration file with processing options")

  // Core Processing
  .option("-i, --input <path>", "input directory (default: pwd)", ".")
  .option("-f, --filter <filter>", "include files by filter (default: **/*)", "**/*")
  .option("-e, --exclude <filter...>", "exclude files by filter(s) (default: empty)")
  .option(
    "-o, --output <path>",
    "output knowledge graph file",
    "knowledge-graph.json"
  )
  .option(
    "-d, --description <text>",
    "short description for the files being processed",
    ""
  )

  // LLM Configuration
  .option(
    "--provider <name>",
    "LLM provider for generation (ollama|openai). 'openai' targets any OpenAI-compatible endpoint via --host",
    "ollama"
  )
  .option("-m, --model <name>", "LLM to use for generation", "llama3.2")
  .option(
    "-h, --host <url>",
    "Ollama host URL, or OpenAI-compatible base URL when --provider openai",
    "http://localhost:11434"
  )
  .option(
    "--api-key <key>",
    "API key for the OpenAI-compatible provider (falls back to OPENAI_API_KEY / KG_API_KEY env)"
  )
  .option("--temperature <number>", "model temperature", "0.1")
  .option(
    "--repeat-penalty <number>",
    "repeat penalty (higher value promotes more diverse results)",
    "0.3"
  )
  .option(
    "--context-length <number>",
    "model context length, should be long enough to fit system prompt, file content/chunk and response (default: 8192)",
    "8192"
  )
  .option(
    "--max-tokens <number>",
    "max output tokens per generation; raise it (or lower --chunk-size) if large knowledge-graph JSON gets truncated mid-output"
  )
  .option("--seed <number>", "model seed", "")
  .option(
    "-s, --system <prompt|path>",
    "LLM system prompt or path to handlebars template"
  )
  .option(
    "--embeddings-provider <name>",
    "embeddings provider (ollama|openai). Independent from --provider; defaults to local Ollama",
    "ollama"
  )
  .option(
    "--embeddings-model <name>",
    "embeddings model used for observations similarity merging",
    "mxbai-embed-large:335m"
  )
  .option(
    "--embeddings-host <url>",
    "embeddings host / OpenAI-compatible base URL",
    "http://localhost:11434"
  )
  .option(
    "--embeddings-api-key <key>",
    "API key for OpenAI-compatible embeddings (falls back to OPENAI_API_KEY / KG_API_KEY env)"
  )
  .option(
    "--embeddings-max-input-chars <n>",
    "truncate embedding inputs to at most N characters (auto-shrinks further if the model still rejects them)",
    "1024"
  )

  // Text Processing
  .option("--chunking", "set chunking mode (disabled|auto|enabled)", "enabled")
  .option("-c, --chunk-size <size>", "maximum chunk size in characters", "2000")
  .option(
    "--overlap-size <size>",
    "overlap size between chunks in characters",
    "100"
  )

  // Whisper Audio/Video Processing
  .option(
    "--asr",
    "set automatic speech recognition mode (disabled|auto|enabled)",
    "enabled"
  )
  .option("--whisper-model <name>", "set whisper model (default: medium)", "medium")
  .option(
    "--language <lang>",
    "set speech recognition language (default: auto)",
    "auto"
  )
  .option(
    "--translate",
    "translate to english (default: false)",
    false
  )

  // Enable Docling PDF/DOC/DOCX/PPT/PPTX Processing
  .option("--docling", "use docling for PDF/DOC/DOCX/PPT/PPTX documents processing (default: false)", false)

  // JSON reading strategy
  .option(
    "--json-strategy <mode>",
    "JSON reader strategy: structural (compact + split on JSON structure, default) or raw (compact + text split)",
    "structural"
  )


  // Content Classification
  .option(
    "--classifier <mode>",
    "content classifier mode (disabled|heuristic|llm)",
    "disabled"
  )

  // Enable Image Processing
  .option("--images", "enable image processing (disabled|auto|enabled)", "auto")

  // Context Retrieval
  .option(
    "--retrieval",
    "set retrieval mode (disabled|auto|enabled)",
    "enabled"
  )
  .option("--retrieval-limit <number>", "context retrieval limit", "3")
  .option(
    "--retrieval-scope <mode>",
    "retrieval granularity: chunk (per-chunk, default) or file (once per file from first chunk)",
    "chunk"
  )

  // Knowledge Graph Merging
  .option(
    "--entity-similarity-threshold <number>",
    "Jaro-Winkler similarity threshold for entity names merging",
    "0.9"
  )
  .option(
    "--observation-similarity-threshold <number>",
    "how similar observation embeddings needs to be so they are considered same",
    "0.9"
  )
  .option(
    "--enable-similarity-merging",
    "set similarity merging for entities and observations",
    true
  )

  // Export Options
  .option(
    "--export-format <format>",
    "export format (json|jsonl|mcp-jsonl|dot)",
    "json"
  )

  // Logging & Debug
  .option("-L, --log-level <level>", "log level", "info")
  .option("-l, --log-file <path>", "log file")
  .option("-D, --debug", "debug mode", false)
  .option("-S, --silent", "silent mode", false)
  .option(
    "--progress-ndjson",
    "emit structured NDJSON progress events (and log lines) to stdout for a parent process / UI to consume; suppresses pretty logging so stdout stays a clean NDJSON stream",
    false
  )

  // Resume / Continuation
  .option(
    "--resume",
    "checkpoint each processed chunk and skip already-done chunks on re-run (survives interrupted/credit-exhausted runs)",
    false
  )
  .option(
    "--checkpoint <path>",
    "checkpoint sidecar file path (default: <output>.checkpoint.jsonl)"
  )

  // Runtime Modes
  .option("-w, --watch", "watch for changes and update knowledge graph", false)
  .option(
    "--export-only",
    "convert an existing knowledge-graph JSON file (--input) to --export-format, written to --output",
    false
  )

  .version(info.version)
  .action(async (options: ProcessingOptions) => {
    // Read configuration file if present
    if (options.config) {
      const tempLogger = LoggerFactory.createLogger(options);

      tempLogger.info(`Reading processing configuration file from ${options.config}`);
      const configOptions = await readConfigurationFile(options.config);

      tempLogger.debug(`Configuration file contents:`, configOptions);

      tempLogger.warn(`Merging configuration file options with CLI arguments`);
      options = {
        ...options,
        ...configOptions,
      };
    }

    // The BERT classifier is not implemented; reject it early with a clear
    // message rather than failing partway through a run.
    if ((options.classifier as string) === "bert") {
      const tempLogger = LoggerFactory.createLogger(options);
      tempLogger.error(
        "The 'bert' classifier is not implemented. Use --classifier heuristic|llm, or disabled."
      );
      process.exit(1);
    }

    // API keys may come from the environment instead of CLI/config.
    const envApiKey = process.env.OPENAI_API_KEY || process.env.KG_API_KEY;
    if (!options.apiKey && envApiKey) {
      options.apiKey = envApiKey;
    }
    if (!options.embeddingsApiKey && envApiKey) {
      options.embeddingsApiKey = envApiKey;
    }

    // Initialize DI container
    const container = ContainerFactory.createContainer({
      processingOptions: options,
    });

    const logger = await container.resolve<Logger>(TYPES.Logger);

    try {
      if (options.exportOnly) {
        await exportCommand(container);
      } else if (options.watch) {
        await watchCommand(container);
      } else {
        await processCommand(container);
      }
    } catch (error) {
      logger.error(`Command failed: ${error}`);
      process.exit(1);
    }
  });

program.parse();
