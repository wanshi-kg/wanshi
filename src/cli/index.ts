#! /usr/bin/env node

import { Command } from "commander";
import * as info from "../../package.json";
import {
  processCommand,
  watchCommand,
  exportCommand,
  metricsCommand,
  inspectMergesCommand,
} from "./commands";
import { ContainerFactory, TYPES } from "../core/di";
import { readConfigurationFile, Logger } from "../shared";
import {
  parseConfig,
  ConfigError,
  configSchemaPayload,
  ProcessingOptions,
} from "../config";
import { cliArgsToConfig, deepMerge, setPath } from "./optionsToConfig";

const program = new Command();

program
  .name(info.name)
  .description(info.description)

  .option("--config <file>", "path to yaml/json configuration file with processing options")

  // Core Processing
  .option("-i, --input <path>", "input directory (default: pwd)")
  .option("-f, --filter <filter>", "include files by filter (default: **/*)")
  .option("-e, --exclude <filter...>", "exclude files by filter(s) (default: empty)")
  .option("-o, --output <path>", "output knowledge graph file")
  .option("-d, --description <text>", "short description for the files being processed")

  // LLM Configuration
  .option(
    "--provider <name>",
    "LLM provider for generation (ollama|openai). 'openai' targets any OpenAI-compatible endpoint via --host"
  )
  .option("-m, --model <name>", "LLM to use for generation")
  .option(
    "-h, --host <url>",
    "Ollama host URL, or OpenAI-compatible base URL when --provider openai"
  )
  .option(
    "--api-key <key>",
    "API key for the OpenAI-compatible provider (falls back to OPENAI_API_KEY / WANSHI_API_KEY env)"
  )
  .option("--temperature <number>", "model temperature")
  .option("--repeat-penalty <number>", "repeat penalty, Ollama only (>1.0 discourages repetition, <1.0 promotes it, 1.0 = off)")
  .option(
    "--context-length <number>",
    "model context length, should be long enough to fit system prompt, file content/chunk and response (default: 8192)"
  )
  .option(
    "--max-tokens <number>",
    "max output tokens per generation; raise it (or lower --chunk-size) if large knowledge-graph JSON gets truncated mid-output"
  )
  .option("--seed <number>", "model seed")
  .option("-s, --system <prompt|path>", "LLM system prompt or path to handlebars template")
  .option(
    "--prompt-version <version>",
    "prompt template version under templates/ (default v5; use v4.5 for the legacy prompts)"
  )
  .option(
    "--embeddings-provider <name>",
    "embeddings provider (ollama|openai). Independent from --provider; defaults to local Ollama"
  )
  .option("--embeddings-model <name>", "embeddings model used for observations similarity merging")
  .option("--embeddings-host <url>", "embeddings host / OpenAI-compatible base URL")
  .option(
    "--embeddings-api-key <key>",
    "API key for OpenAI-compatible embeddings (falls back to OPENAI_API_KEY / WANSHI_API_KEY env)"
  )
  .option(
    "--embeddings-max-input-chars <n>",
    "truncate embedding inputs to at most N characters (auto-shrinks further if the model still rejects them)"
  )

  // Text Processing
  .option("--chunking <mode>", "set chunking mode (disabled|auto|enabled)")
  .option("-c, --chunk-size <size>", "maximum chunk size in characters")
  .option("--overlap-size <size>", "overlap size between chunks in characters")

  // Whisper Audio/Video Processing
  .option("--asr <mode>", "set automatic speech recognition mode (disabled|auto|enabled)")
  .option("--whisper-model <name>", "set whisper model (default: medium)")
  .option("--language <lang>", "set speech recognition language (default: auto)")
  .option("--translate", "translate to english (default: false)")

  // Enable Docling PDF/DOC/DOCX/PPT/PPTX Processing
  .option("--docling", "use docling for PDF/DOC/DOCX/PPT/PPTX documents processing (default: false)")

  // Quarantine trailing references/bibliography sections before extraction
  .option("--strip-references", "quarantine trailing references/bibliography sections before extraction (PDF + markdown, default: false)")

  // Reference & link resolution (Phase 0, network-free; off by default)
  .option("--reference-links", "resolve internal links ([x](./other.md), [[wikilinks]], HTML href) to corpus files as links_to edges (default: false)")
  .option("--reference-citations", "parse bibliography + inline arXiv/DOI/PMID into cites edges (network-free; default: false)")
  .option("--reference-follow", "follow internal links to discover & process referenced files (each once); network-free, confined to input (default: false)")
  .option("--reference-web", "fetch allowlisted external web links, extract, emit references edges (opt-in network; needs references.web.allowlist) (default: false)")
  // Reference & link resolution (Phase 2, citation span-fetch; opt-in network, off by default)
  .option("--reference-citation-fetch", "resolve id-bearing cites to OA full text and fetch it (opt-in network; auto-enables citation extraction) (default: false)")
  .option("--unpaywall-email <email>", "Unpaywall polite-pool email (or $UNPAYWALL_EMAIL) — required to resolve DOI citations")
  .option("--grobid", "use a local GROBID service to link citation markers to references (enables span-select + faithfulness) (default: false)")
  .option("--grobid-url <url>", "GROBID service base URL (default: http://localhost:8070)")
  .option("--reference-title-resolver", "resolve id-less references to a DOI/arXiv id via Crossref/Semantic Scholar/OpenAlex (default: false)")

  // JSON reading strategy
  .option(
    "--json-strategy <mode>",
    "JSON reader strategy: structural (compact + split on JSON structure, default) or raw (compact + text split)"
  )

  // Content Classification
  .option("--classifier <mode>", "content classifier mode (disabled|heuristic|llm|cascade)")

  // Enable Image Processing
  .option("--images <mode>", "enable image processing (disabled|auto|enabled)")

  // Context Retrieval
  .option("--retrieval <mode>", "set retrieval mode (disabled|auto|enabled)")
  .option("--retrieval-limit <number>", "context retrieval limit")
  .option(
    "--retrieval-scope <mode>",
    "retrieval granularity: chunk (per-chunk, default) or file (once per file from first chunk)"
  )

  // Inline Grounding Gate
  .option(
    "--grounding <mode>",
    "inline grounding gate: disabled | flag (annotate observations) | drop (remove ungrounded ones)"
  )
  .option(
    "--grounding-min-score <number>",
    "minimum keyword-overlap grounding score (0..1) an observation must reach"
  )
  .option(
    "--grounding-checker <checker>",
    "grounding checker: keyword (overlap) | minicheck (local NLI fact-checker)"
  )
  .option(
    "--grounding-model <model>",
    "Ollama model for the minicheck grounding checker (default bespoke-minicheck:7b)"
  )

  // Corpus Analysis Pre-pass (experimental)
  .option(
    "--corpus-profiling <mode>",
    "corpus analysis pre-pass: disabled | enabled (term frequency + cached classification + LLM glossary, injected as naming hints)"
  )
  .option("--corpus-top-terms <number>", "number of most-frequent terms fed to the glossary call")
  .option("--corpus-profile-path <path>", "corpus profile sidecar path (default: <output>.corpus-profile.json)")

  // AST symbol seed (code extraction)
  .option(
    "--ast <mode>",
    "AST symbol seed: enabled | disabled (seed code definitions + exported members as entities before the LLM)"
  )

  // Knowledge Graph Merging
  .option("--entity-similarity-threshold <number>", "Jaro-Winkler similarity threshold for entity names merging")
  .option(
    "--observation-similarity-threshold <number>",
    "how similar observation embeddings needs to be so they are considered same"
  )
  .option("--enable-similarity-merging", "set similarity merging for entities and observations")
  .option(
    "--supersession <mode>",
    "merge-time supersession (KG-10): disabled | heuristic | llm — invalidate an older contradicted fact instead of deleting it"
  )

  // Export Options
  .option("--export-format <format>", "export format (json|jsonl|mcp-jsonl|dot|kblam|lora|graphiti)")

  // Logging & Debug
  .option("-L, --log-level <level>", "log level")
  .option("-l, --log-file <path>", "log file")
  .option("-D, --debug", "debug mode")
  .option("-S, --silent", "silent mode")
  .option(
    "--progress-ndjson",
    "emit structured NDJSON progress events (and log lines) to stdout for a parent process / UI to consume; suppresses pretty logging so stdout stays a clean NDJSON stream"
  )

  // Resume / Continuation
  .option(
    "--resume",
    "checkpoint each processed chunk and skip already-done chunks on re-run (survives interrupted/credit-exhausted runs)"
  )
  .option("--checkpoint <path>", "checkpoint sidecar file path (default: <output>.checkpoint.jsonl)")

  // Runtime Modes
  .option("-w, --watch", "watch for changes and update knowledge graph")
  .option(
    "--export-only",
    "convert an existing knowledge-graph JSON file (--input) to --export-format, written to --output"
  )

  .version(info.version)
  .action(async (cliOptions: Record<string, any>) => {
    // Resolve the effective config: defaults < file < CLI flags < env. CLI flags
    // carry no Commander defaults, so an unset flag never overrides file config.
    const fileRaw: Record<string, any> = cliOptions.config
      ? ((await readConfigurationFile(cliOptions.config)) as Record<string, any>)
      : {};
    const cliRaw = cliArgsToConfig(cliOptions);
    const merged = deepMerge(fileRaw, cliRaw);

    // API keys may come from the environment instead of CLI/config.
    // WANSHI_API_KEY is the branded var; KG_API_KEY kept as a deprecated fallback.
    const envApiKey =
      process.env.OPENAI_API_KEY || process.env.WANSHI_API_KEY || process.env.KG_API_KEY;
    if (envApiKey) {
      if (!merged.llm?.apiKey) setPath(merged, "llm.apiKey", envApiKey);
      if (!merged.embeddings?.apiKey) setPath(merged, "embeddings.apiKey", envApiKey);
    }

    let options: ProcessingOptions;
    try {
      options = parseConfig(merged);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }

    // The BERT classifier is not implemented; reject it early with a clear
    // message rather than failing partway through a run.
    if (options.classifier.mode === "bert") {
      console.error(
        "The 'bert' classifier is not implemented. Use --classifier heuristic|llm, or disabled."
      );
      process.exit(1);
    }

    // Initialize DI container
    const container = ContainerFactory.createContainer({
      processingOptions: options,
    });

    const logger = await container.resolve<Logger>(TYPES.Logger);

    try {
      if (options.runtime.exportOnly) {
        await exportCommand(container);
      } else if (options.runtime.watch) {
        await watchCommand(container);
      } else {
        await processCommand(container);
      }
    } catch (error) {
      logger.error(`Command failed: ${error}`);
      process.exit(1);
    }
  });

// `wanshi schema` — emit the config JSON Schema + UI metadata so a frontend can
// render the run form without duplicating the option list. The single source of
// truth is the Zod ConfigSchema in src/config.
program
  .command("schema")
  .description("print the configuration JSON Schema (+ UI group metadata) as JSON")
  .option("--json", "compact single-line JSON (default is pretty-printed)")
  .action((opts: { json?: boolean }) => {
    const payload = configSchemaPayload();
    process.stdout.write(JSON.stringify(payload, null, opts.json ? 0 : 2) + "\n");
  });

// `wanshi metrics <graph.json>` — the no-ground-truth A/B scorecard (entity/
// relation-type counts, self-loops, bidirectional contradictions, referential
// integrity, parallel edges). With --ground-truth it adds semantic triple
// precision/recall + fabricated-edge rate. Used to capture the baseline numbers
// and to score every canonicalization arm uniformly.
program
  .command("metrics")
  .description("compute knowledge-graph health metrics (and ground-truth scores) for a json graph")
  .argument("<graph.json>", "path to a json-format knowledge graph ({entities, relations})")
  .option("--config <file>", "config file (for embeddings/provider settings, used only with --ground-truth)")
  .option("--ground-truth <file.jsonl>", "JSONL of ground-truth triples/edges for precision/recall + fabricated-edge rate")
  .option("--match-threshold <number>", "semantic match cosine threshold (default 0.80)")
  .option("--output <file>", "also write the full metrics report as JSON to this path")
  .action(async (graphPath: string, opts) => {
    try {
      await metricsCommand(graphPath, opts);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// `wanshi inspect-merges <merges.jsonl>` — table view over the canonicalization
// merge log: what got fused, how tight each cluster was, suspicious over-merges
// first. The merge log is the experiment's deliverable, not the graph.
program
  .command("inspect-merges")
  .description("render the canonicalization merge log as a table (suspicious over-merges first)")
  .argument("<merges.jsonl>", "path to a merges.jsonl emitted by a canonicalization run")
  .option("--target <kind>", "only show 'entity' or 'relation' clusters")
  .option("--suspect-below <number>", "flag clusters whose min intra-cluster sim is below this (default 0.80)")
  .option("--limit <number>", "limit the number of rows printed")
  .action((logPath: string, opts) => {
    try {
      inspectMergesCommand(logPath, opts);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
