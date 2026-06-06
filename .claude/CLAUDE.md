# CLAUDE.md — Agent Instructions for kg-gen

## Project Overview

**kg-gen** is a TypeScript CLI tool that transforms files and codebases into structured knowledge graphs using local LLMs via Ollama or any OpenAI-compatible API provider. It extracts entities, observations (facts), and relations, then merges them into a queryable knowledge graph exportable in JSON, JSONL, MCP-compatible JSONL, or GraphViz DOT formats.

**LLM providers**: generation runs on local Ollama *or* any OpenAI-compatible endpoint (OpenAI, OpenRouter, vLLM, Ollama Cloud, …), selected via `provider`/`host`/`apiKey`. Embeddings are configured independently (`embeddingsProvider`/`embeddingsHost`/`embeddingsApiKey`) and default to local Ollama, so dedup/retrieval stays free even when generation is on a metered cloud. See [LLM Providers & Resume](#llm-providers--resume).

## Tech Stack

| Concern | Tool |
| ------- | ---- |
| Language | TypeScript 5.6 (strict mode, ES6 target, CommonJS modules) |
| Runtime | Node.js 18+ |
| LLM | Ollama via `ollama` npm package, or any OpenAI-compatible API via `openai` npm package |
| CLI | Commander.js |
| DI | Custom async `DIContainer` |
| Schema validation | Zod + `zod-to-json-schema` |
| Text splitting | `@langchain/textsplitters` `RecursiveCharacterTextSplitter` |
| Prompt templating | Handlebars |
| Embeddings | Ollama embeddings API or OpenAI-compatible (default: local `mxbai-embed-large:335m`) |
| Logging | `tslog` via `LoggerFactory` |
| Testing | Jest + ts-jest (installed, no test files yet) |

## Development Commands

```bash
npm start                     # Run CLI via ts-node (development)
npm run build                 # Compile TypeScript → dist/
node ./dist/index.js          # Run compiled binary
npx nodemon                   # Auto-restart on file changes

# Example run against a config
npx ts-node ./src/index.ts --config config.yaml

# Benchmark extraction quality against CrossRE dataset
npm run benchmark -- --dataset crossre --data-path ./data/crossre/crossre_data/ai-test.json --limit 20
# Options: --dataset rebel|crossre  --limit N  --match-threshold 0.80
#          --model <ollama-model>  --classifier disabled|heuristic|llm|bert
#          --output ./results/run.json  (saves full per-sample JSON report)
```

> `npm test` in package.json runs against a hardcoded personal config path — not a real test suite.

## Project Structure

```plain
kg-gen/
├── src/
│   ├── index.ts                          # Main re-export entry point
│   ├── cli/
│   │   ├── index.ts                      # CLI entry point (Commander.js, 40+ options)
│   │   └── commands/
│   │       ├── process.command.ts        # One-shot directory processing
│   │       ├── watch.command.ts          # Watch mode (chokidar)
│   │       └── export.command.ts         # Export existing graph
│   ├── core/
│   │   ├── DirectoryProcessor.ts         # ★ Main orchestrator — start here
│   │   ├── di/
│   │   │   ├── DIContainer.ts            # Async DI container with singleton management
│   │   │   ├── ContainerFactory.ts       # All 16+ service registrations
│   │   │   └── index.ts                  # TYPES symbols (service identifiers)
│   │   ├── llm/
│   │   │   ├── OllamaService.ts          # Ollama integration, structured generation (Zod)
│   │   │   ├── OpenAICompatibleService.ts # OpenAI-compatible generation (response_format json_schema + fallback)
│   │   │   ├── EmbeddingService.ts       # Ollama embeddings with in-memory cache
│   │   │   ├── OpenAIEmbeddingService.ts # OpenAI-compatible embeddings (native batching + cache)
│   │   │   └── prompts/
│   │   │       ├── PromptManager.ts      # Prompt orchestration
│   │   │       ├── PromptTemplateEngine.ts # Handlebars rendering + context enhancement
│   │   │       └── templates/
│   │   │           ├── v1 … v4, v4.5/    # Versioned prompt templates (v4.5 = default; v5 removed)
│   │   │           └── partials/         # Reusable partials + domain examples
│   │   ├── checkpoint/
│   │   │   └── CheckpointService.ts      # Per-chunk resume sidecar (JSONL) for --resume
│   │   ├── corpus/                       # Corpus pre-pass: term frequency + glossary (--corpus-profiling)
│   │   │   ├── CorpusAnalyzer.ts         # Build/load CorpusProfile (freq + cached class + LLM glossary)
│   │   │   ├── termFrequency.ts          # Pure term counter (content words + proper-noun runs)
│   │   │   └── CorpusProfileStore.ts     # Cached sidecar (<output>.corpus-profile.json)
│   │   ├── processor/
│   │   │   ├── FileProcessor.ts          # Read → chunk → classify pipeline
│   │   │   ├── readers/                  # 11 file type readers (see below)
│   │   │   ├── chunking/TextChunker.ts   # RecursiveCharacterTextSplitter wrapper
│   │   │   └── classifier/               # Heuristic/BERT/LLM classifiers (experimental)
│   │   ├── knowledge/
│   │   │   ├── KnowledgeGraphBuilder.ts  # LLM extraction with Zod schema validation
│   │   │   ├── merging/KnowledgeMerger.ts # 3-level hierarchical merge
│   │   │   └── search/KnowledgeGraphSearch.ts # Multi-strategy context retrieval
│   │   └── export/
│   │       ├── KnowledgeGraphExportService.ts # Export orchestrator (strategy pattern)
│   │       └── strategies/               # json, jsonl, mcp-jsonl, dot implementations
│   ├── types/
│   │   ├── KnowledgeGraph.ts             # Entity, Relation, KnowledgeGraph types
│   │   ├── ProcessingOptions.ts          # Full CLI/config options interface
│   │   └── I*.ts                         # Service interfaces
│   └── shared/
│       ├── logger/                       # Logger interface + tslog factory
│       └── utils/                        # cosineSimilarity, jaroWinklerSimilarity, etc.
├── src/quality/                          # Importable quality metrics (structural, semantic, factual, consistency)
├── src/evaluation/                       # Benchmark harness: datasets (CrossRE/REBEL), matching, metrics, reporters
├── data/crossre/crossre_data/            # Downloaded CrossRE domain splits (gitignored)
├── scripts/benchmark.ts                 # Standalone benchmark CLI (ts-node)
├── examples/                             # Sample integrations and output files
│   ├── kg-mail-assistant/                # Full Gmail-to-KG example
│   └── t3.ts … t6.ts                     # Ad-hoc test/example scripts
└── doc-classifier/                       # Related document classifier subproject
```

## Core Data Model

```typescript
// src/types/KnowledgeGraph.ts
interface Entity {
  name: string;            // Unique identifier — snake_case for code/technical entities; original casing for proper nouns
  entityType: string;      // Category: "class", "function", "concept", "person", etc.
  observations: Observation[]; // Provenance-stamped facts (see below)
  files: string[];         // Source file paths
  chunk?: number;          // Chunk index (1-based) if file was split
  totalChunks?: number;    // Total chunks in source file
}

// src/types/Observation.ts — observations are objects, not bare strings.
interface Observation {
  text: string;
  speaker?: string;   // per-observation provenance: who asserted it
  source?: string;    // origin file/path
  validAt?: string;   // bi-temporal valid time (true in the world from)  [Graphiti-verbatim]
  invalidAt?: string; // valid time end
  createdAt?: string; // transaction time: when extracted/ingested
  expiredAt?: string; // transaction time: when superseded (facts are superseded, never deleted)
}
```

**Provenance is built, not asked of the model.** The LLM still emits observations as
bare strings; `KnowledgeGraphBuilder.toGraph()` wraps each into an `Observation`,
stamping `source`/`speaker`/`validAt` from the chunk's `ChunkProvenance` (reader-supplied)
plus `createdAt`. Read sites use the `obsText()` / `normalizeObservations()` helpers and
tolerate legacy bare-string data; **MCP export downgrades to bare strings** so the memory
server stays compatible.

**`entityType` enum (per-domain).** When a content class is detected,
`KnowledgeGraphBuilder.buildGraphSchema(allowedTypes)` constrains `entityType` to a Zod
**enum** = that domain's `primaryEntityTypes` (from `NER_DOMAIN_EXAMPLES`) + generic types +
an `other` escape hatch; with no class detected it stays a free string. The schema is built
per chunk from the chunk's classification.

**Inline grounding gate (`--grounding`).** After each chunk is extracted,
`KnowledgeGraphBuilder.applyGroundingGate()` scores every observation against its source
chunk via `FactualEvaluator.observationGroundingScore()` (keyword overlap; the seam for a
stronger NLI-style check). Modes: `disabled` (default), `flag` (annotate each observation
with `grounded`/`groundingScore`, keep all), `drop` (remove observations below
`--grounding-min-score`, default 0.5). Runs before checkpoint/merge, so ungrounded facts
never reach the output.

```typescript
interface Relation {
  from: string;           // Source entity name
  to: string;             // Target entity name
  relationType: string[]; // Array of relation type strings
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}
```

## Architecture Patterns

### 1. Dependency Injection

All services are managed by `DIContainer`. Use `TYPES.*` Symbol identifiers to register and resolve:

```typescript
// ContainerFactory.ts pattern
container.register(TYPES.SomeService, () => new SomeService(dep1, dep2));
const svc = container.get<ISomeService>(TYPES.SomeService);
```

**To add a new service**: implement its interface, register in `ContainerFactory.ts`, add a Symbol to the `TYPES` map in `ContainerFactory.ts` (re-exported via `src/core/di/index.ts`).

### 2. Strategy Pattern — File Readers

`FileReaderFactory` maps file extensions to reader implementations. All readers extend the abstract `FileReader` base class.
**To add a new file format**: implement `FileReader`, register in `FileReaderFactory.ts`.

### 3. Strategy Pattern — Export Formats

`KnowledgeGraphExportService` delegates to registered `IExportStrategy` implementations. `ProcessingOptions` is forwarded to strategies — `DirectoryProcessor` passes it through `export(graph, format, options)`, and the DOT strategy reads `dotOptions` (config-only; layout, rankdir, colorScheme, clustering, legend, …) plus the graph title and processing-config cluster.
**To add a new export format**: implement `IExportStrategy`, register in `KnowledgeGraphExportService`.

Formats: `json` · `jsonl` · `mcp-jsonl` (memory-server compatible) · `dot` · and the **KBLaM/LoRA-prep** trio (Phase 4):
- **`kblam`** — JSONL `DataPoint`s `{name, description_type, description, Q, A, key_string}`, the on-disk shape KBLaM's `dataset_generation` ingests. Observations → `(entity, "fact", text)`; relations → `(from, relationType, to)`. Feeds KBLaM's KB-embedding step.
- **`lora`** — chat SFT JSONL (`{messages:[user Q, assistant A]}`) from the same triples, **quality-filtered**: observations below `--grounding-min-score` (Phase 3 `groundingScore`) are dropped, so only grounded facts train.
- **`graphiti`** — `add_triplet`-shaped `{nodes: EntityNode[], edges: EntityEdge[]}` (bi-temporal ingestion target). Entities→nodes (summary from observations), relations→edges with `created_at`; per-fact valid-time stays in `json`/`kblam` (fact-as-temporal-edge is a future refinement).

### 4. Hierarchical Merging (3 Levels)

`KnowledgeMerger` applies progressively stricter deduplication:

- **Within-file**: Jaro-Winkler threshold × 0.7, embedding similarity × 0.8 (aggressive)
- **Cross-file**: Full `entitySimilarityThreshold` (default 0.9), full `observationSimilarityThreshold` (conservative)
- Entity names: Jaro-Winkler similarity
- Observations: Cosine similarity of embeddings (provider-selectable)
- **Provenance-preserving:** `deduplicateObservations` partitions by provenance identity (`source␟speaker`) and only collapses near-duplicates *within* a group — the same fact from two sources/speakers stays as two attributed `Observation`s, never one flattened string.

### 5. Prompt Versioning

Templates live in `src/core/llm/prompts/templates/` (`v1`–`v4` plus `v4.5`). Default is **v4.5** (set in `PromptManager.ts`); v5 was removed. Each version has `system.hbs` and `user.hbs` with Handlebars syntax. Partials live in `templates/partials/` and domain examples in `partials/examples/`.

### 6. Classifier → Prompt Routing (two-part system)

When a classifier runs, the detected `ContentClass` is used in **two separate ways** by `PromptManager`:

- **Domain hints** — built from `NER_DOMAIN_EXAMPLES.ts` (`primaryEntityTypes` + `primaryRelationTypes`), injected into the **user prompt** (`user.hbs`) as `{{domainHints}}`. Renders as a short bulleted list steering the model toward domain-appropriate terminology.
- **Domain examples** — loaded from `partials/examples/<class>.md` via `CLASS_TO_PARTIAL`, injected into the **system prompt** (`system.hbs`) as `{{domainExamples}}`. Full few-shot input→output pairs showing what to extract for that content type.

`NER_DOMAIN_EXAMPLES.ts` also has an `examples` array per domain — this is **dead code**; `buildDomainHints()` only reads `primaryEntityTypes`/`primaryRelationTypes`.

### 7. Document Outline injection

`PromptTemplateEngine.enhanceContext()` generates a per-file structural outline (via the `document-outline-gen` lib, wrapped in `documentOutline.ts`) and injects it into the user prompt as `{{fileOutline}}`. Configured by the YAML-only nested `outline` group (`enabled` default true, plus `maxDepth`/`includeLineNumbers`/`includePrivate`/`includeComments`), threaded `ContainerFactory` → `PromptManager` ctor → `PromptTemplateEngine`. Set `outline.enabled: false` to skip it (saves tokens, silences outline warnings).

**To add or improve a domain**, edit both files together:

1. `src/core/processor/classifier/NER_DOMAIN_EXAMPLES.ts` — update `primaryEntityTypes` / `primaryRelationTypes` for the domain
2. `src/core/llm/prompts/templates/partials/examples/<class>.md` — add/improve worked examples (2+ input→output pairs in the standard format)

## LLM Providers & Resume

### Provider selection

`provider` and `embeddingsProvider` (`ollama` | `openai`) are chosen independently in `ContainerFactory`:

| Option | Generation | Embeddings |
| ------ | ---------- | ---------- |
| Provider | `provider` | `embeddingsProvider` |
| Endpoint | `host` (base URL when `openai`) | `embeddingsHost` |
| API key | `apiKey` | `embeddingsApiKey` |
| Model | `model` | `embeddingsModel` |

Both keys fall back to `$OPENAI_API_KEY` / `$KG_API_KEY` if unset (so secrets needn't live in `config.yaml`). The `openai` provider works with any OpenAI-compatible endpoint (OpenAI, OpenRouter, Together, vLLM, Ollama Cloud). Default = local Ollama for both.

**To add a new provider**: implement `ILLMProvider` (and/or `IEmbeddingProvider`), then branch on it in the `TYPES.LLMService` / `TYPES.EmbeddingService` factories in `ContainerFactory.ts`.

### Resume / continuation

`--resume` (or `resume: true`) makes `KnowledgeGraphBuilder` checkpoint every chunk to a sidecar JSONL (`<output>.checkpoint.jsonl`, override with `--checkpoint`). The flag enables **both** write and read: start a long run with it, and if the run dies (credits exhausted, crash) just re-run the same command — already-processed chunks are restored from the checkpoint and skipped, no re-billing.

- Work-unit key = sha1 of `(pathRelativeToInput, chunkIndex, chunkContent, model, promptVersion)` — editing a file, changing chunk size (→ different content), switching models, or changing the prompt invalidates the affected entries. The path component is the file path **relative to `input`** (posix-normalized, computed in `KnowledgeGraphBuilder.stablePathId`), so **moving the whole input tree or changing the `input` prefix no longer invalidates resume** — only renaming an individual file *within* the tree re-runs that one file. Records also store `model`/`promptVersion` (and `relPath` for transparency) so `load()` reports how many match the current run and warns when none do (the usual reason "resume" appears to do nothing after a config change).
- Merge still runs once at the end over all per-chunk graphs (cross-file dedup can't be incremental), so resume saves the expensive extraction calls, not the final merge.
- `CheckpointService.load()` tolerates a truncated final line from an interrupted write.

**Graceful interrupt.** `src/shared/shutdown.ts` is a module-singleton flag. The CLI
(`process.command.ts`) wires SIGINT/SIGTERM/Ctrl+D to `shutdown.request()`; the file loop
(`DirectoryProcessor`) and chunk loop (`KnowledgeGraphBuilder`) poll `shutdown.isRequested()`
between units so the first interrupt finishes the in-flight chunk, checkpoints it, then
merges + exports the partial graph; a second interrupt force-quits.

**Retrieval scope.** `retrievalScope` (default `chunk`) controls whether
`DirectoryProcessor.buildRetriever()` retrieves context per chunk (using each chunk's own
content) or once per file from the first chunk (`file`, legacy). Entity embeddings are
cached by text, so per-chunk retrieval mostly reuses cached vectors.

## Key Conventions

- **TypeScript strict mode** — no implicit `any`; use explicit types
- **CommonJS modules** — imports compile to `require()` (no ESM)
- **Domain-appropriate entity naming** — snake_case for code/technical identifiers; original casing preserved for proper nouns (people, places, organizations)
- **Async/await throughout** — no callbacks, no `.then()` chains
- **Graceful error handling** — individual file failures return empty KG; processing continues for remaining files
- **Structured logging** — use injected `logger` (tslog), not `console.log`
- **Interface-first design** — all services have `I*.ts` interface files in `src/types/`
- **Provider-agnostic LLM layer** — generation and embeddings both go through interfaces (`ILLMProvider`, `IEmbeddingProvider`); backend is chosen in `ContainerFactory` from `provider`/`embeddingsProvider`

## Processing Pipeline

```plain
CLI args / config.yaml
    ↓
ContainerFactory.create(options) → DIContainer
    ↓
DirectoryProcessor.processDirectory()
    ↓
FileDiscoveryService.discover()          ← glob patterns
    ↓
[CorpusAnalyzer.analyzeOrLoad()]         ← --corpus-profiling enabled: term frequency + cached classification + 1 LLM glossary call (cached sidecar)
    ↓
For each file:                           ← [graceful interrupt checked between files]
  FileProcessor.processFile()            ← select reader → read → chunk → [classify]
  PromptManager.getSystemPrompt()        ← render Handlebars system template
  KnowledgeGraphBuilder.build()          ← per-chunk: [interrupt? finish+stop] → retrieve context for THIS chunk (retrievalScope) → [resume? skip if checkpointed] → render user prompt → LLM provider (Ollama | OpenAI-compatible) → Zod validate → [checkpoint append]
    ↓
KnowledgeMerger.merge()                  ← 3-level hierarchical merge
    ↓
KnowledgeGraphExportService.export()     ← json | jsonl | mcp-jsonl | dot
    ↓
Output file
```

### Corpus analysis pre-pass (`--corpus-profiling`, experimental, default off)

Before extraction, `CorpusAnalyzer` (`src/core/corpus/`) builds a corpus-global
`CorpusProfile` (cached to `<output>.corpus-profile.json`): it reads each file (char-capped),
counts term frequency (`countTerms`, pure — lowercased content words + capitalized
multiword proper-noun runs, stopword/number/short dropped), runs content classification
**once** (cached in `perFileClasses`, reused by `FileProcessor` so the classifier isn't
re-run per file), then makes **one** `ILLMProvider.generateStructured` call returning a
`CorpusGlossary {entityNames, entityTypes, relationTypes}`. The glossary is threaded
explicitly (`DirectoryProcessor` → `KnowledgeGraphBuilder.build(…, glossary)`) and injected
as a **soft hint**: a `{{corpusGlossary}}` block in `user.hbs` ("prefer these canonical
forms, don't force-fit") plus a union of `glossary.entityTypes` into the `resolveAllowedTypes`
entityType enum (names are never enum'd, so new entities are still discovered). The aim is
consistent entity *naming* up front, complementing the downstream Jaro-Winkler/embedding
merge. Cached by a key over (sorted relpaths + model + topN + classifier); a stale key
rebuilds. Profiling is an enhancement — any failure (e.g. the glossary LLM emitting bad JSON)
is caught and the run continues without it. Flags: `--corpus-profiling disabled|enabled`,
`--corpus-top-terms` (100), `--corpus-profile-path`. `corpusClustering` is a v2 stub
(embedding clustering of terms, deferred). The glossary call uses `ILLMProvider` (honors the
`openai` provider), unlike `LlmContentClassifier` which still hits Ollama directly.

## File Readers (src/core/processor/readers/)

| Reader | Extensions | Library |
| ------ | ---------- | ------- |
| `TranscriptReader` | speaker-labeled `*.parakeet.txt`/`*.whisper.txt`/`*.corrected.txt`, transcript-shaped `.json` | Built-in (registered **first**; content-sniffing `canRead`) |
| `TextReader` | `.txt`, most text/code files | Built-in |
| `JsonFileReader` | `.json`, `.jsonl`, `.geojson` | Built-in (registered before `TextReader`) |
| `MarkdownReader` | `.md` | Built-in |
| `PdfReader` | `.pdf` | `pdf2json` |
| `HtmlReader` | `.html`, `.htm` | `cheerio` + `html-to-text` |
| `OfficeReader` | `.docx`, `.xlsx`, `.pptx` | `officeparser` |
| `RtfReader` | `.rtf` | `rtf-parser` |
| `ImageReader` | `.jpg`, `.png`, `.gif`, `.webp`, etc. | Vision model via Ollama |
| `AudioReader` | `.mp3`, `.wav`, `.ogg`, `.m4a`, etc. | `nodejs-whisper` + `fluent-ffmpeg` |
| `DoclingReader` | `.pdf`, `.doc`, `.docx`, `.ppt`, `.pptx` | Docling API (opt-in) |
| `BinaryReader` | Unknown/binary | Skips gracefully |

**TranscriptReader** (`src/core/processor/readers/TranscriptReader.ts`) is registered **before** `JsonFileReader`/`TextReader` and overrides `canRead` to claim only files that sniff as transcripts (deferring everything else). It normalizes three real shapes — recua speaker-labeled text (`SPEAKER_XX:` blocks), recua turns JSON (`[{start,end,speaker,<backend>}]`), and Claude/ChatGPT chat exports (`[{chat_messages:[{sender,created_at,…}]}]`) — into `Turn[]`, then **size-packs** them into chunks capped at `maxChunkSize` (tied to the global `chunkSize` via `ContainerFactory`), rendering each turn inline as `speaker: text`. A turn longer than the budget is split with its label kept on every piece. `ChunkProvenance {source, occurredAt}` is always set; `speaker` is set **only when a chunk is single-speaker** (mixed chunks keep the speaker labels inline in the content instead). This keeps a long dialogue to a handful of chunks (was one-per-turn → an LLM call per turn, the `--chunk-size`-ignored explosion). Inline labels keep speakers visible to the model as dialogue provenance without each `SPEAKER_XX` becoming an entity.

**JsonFileReader** (`src/core/processor/readers/JsonFileReader.ts`) is registered **before** `TextReader` in `ContainerFactory` (first-match-wins) so it claims `.json`/`.jsonl`/`.geojson`. It re-serializes JSON compactly (token savings) and chunks on structure — top-level array elements, an object's dominant array (e.g. `{conversations:[…]}`, header of sibling keys preserved), or JSONL lines — packing to `jsonReader.maxChunkSize` (default = global `chunkSize`) and recursing one level into oversized elements. Malformed JSON falls back to raw text chunking (never throws). Config: `--json-strategy structural|raw` + nested `jsonReader: { strategy, maxChunkSize }`.

## LLM Integration Details

Both backends implement `ILLMProvider.generateStructured<T>()` (zod → JSON schema, parse, strip code blocks, zod-validate, retry 3× with backoff, empty graph on permanent failure):

- **`OllamaService`** — sends to Ollama with the `format` constraint.
- **`OpenAICompatibleService`** — `chat.completions.create` with `response_format: json_schema` (`strict: false`); on a provider/model that rejects json_schema it falls back to `json_object` + schema-in-prompt (handles Gemma-style endpoints). `host` is the base URL, `apiKey` the bearer token. No model-introspection endpoint, so `getModelCapabilities()` returns `[]` (vision is attached on faith when `--images` is on).
- **Output truncation.** Both services pass `maxTokens` (`--max-tokens` → OpenAI `max_tokens` / Ollama `num_predict`) when set, and warn on a `length` finish/done reason — the common cause of `SyntaxError` JSON parse failures on huge chunks is the model running out of output budget. Fix by raising `--max-tokens` or lowering `--chunk-size`.

**Embeddings** — `IEmbeddingProvider` (`embed`/`embedBatch`, in-memory cache):

- **`EmbeddingService`** — Ollama, batches of 10.
- **`OpenAIEmbeddingService`** — OpenAI-compatible, native array batching (100/req) to cut request count.
- Both truncate inputs to `embeddingsMaxInputChars` (default 1024) before the API call, and **adaptively halve + retry** if the model still rejects the input as too long (see `embeddingUtils.ts`), so long observations/entities/JSON chunks can't overflow the embedding model's context.
- Used for observation deduplication and context retrieval. Chosen independently from generation, so cloud generation + free local embeddings is the default.

## Testing

No automated test suite exists yet. `jest` + `ts-jest` are installed.

When writing new tests:

- Place files as `*.test.ts` next to source or in `__tests__/` directories
- Mock the LLM provider to avoid an Ollama/network dependency in CI — depend on `ILLMProvider` and inject a stub (the builder takes `llmService: ILLMProvider`)
- Quality metrics live in `src/quality/` (structural, semantic, factual, consistency, composite) — importable from `src/`
- `src/evaluation/` contains the benchmark harness (datasets, matching, metrics, reporters); run via `npm run benchmark` (the original `test/` evaluators were removed in favor of these)

## Common Tasks

### Add a new file reader

1. Create `src/core/processor/readers/MyReader.ts` extending `FileReader`
2. Implement `read(filePath: string): Promise<FileReadResult>`
3. Register in `FileReaderFactory.ts` with associated extensions

### Add a new export format

1. Create `src/core/export/strategies/MyExportStrategy.ts` implementing `IExportStrategy`
2. Register in `KnowledgeGraphExportService.ts`
3. Add format value to `ExportFormat` type in `ProcessingOptions.ts`
4. Add CLI option handling in `src/cli/index.ts`

### Add a new service

1. Define interface in `src/types/IMyService.ts`
2. Implement in `src/core/.../MyService.ts`
3. Add a Symbol to the `TYPES` map in `ContainerFactory.ts`: `MyService: Symbol.for('MyService')`
4. Register in `ContainerFactory.ts`

### Modify prompt templates

Templates are in `src/core/llm/prompts/templates/v4.5/` (current default):

- `system.hbs` — system prompt with context (directory tree, description, examples)
- `user.hbs` — per-chunk user prompt (file path, chunk info, retrieved context, content)
- `partials/` — reusable Handlebars partials
- `partials/examples/` — domain-specific extraction examples

### Run against a real project (local Ollama)

```bash
cat > config.yaml << 'EOF'
input: /path/to/project
filter: ["**/*.ts", "**/*.md"]
exclude: ["**/node_modules/**", "**/dist/**"]
output: ./kg-output.jsonl
model: gemma3:4b
exportFormat: jsonl
logLevel: debug
EOF

npx ts-node ./src/index.ts --config config.yaml
```

### Run against a cloud provider, resumably (OpenRouter + local embeddings)

```bash
cat > config.yaml << 'EOF'
input: /path/to/claude-chats-export
filter: ["**/*.json"]
output: ./kg-output.jsonl
exportFormat: jsonl

# Generation on OpenRouter (host = base URL); key can also come from $OPENAI_API_KEY
provider: openai
host: https://openrouter.ai/api/v1
apiKey: sk-or-...
model: google/gemma-3-27b-it

# Embeddings stay local & free (default), so dedup/merge costs nothing
embeddingsProvider: ollama
embeddingsModel: mxbai-embed-large:335m

resume: true   # writes <output>.checkpoint.jsonl; re-run the same command to continue
EOF

npx ts-node ./src/index.ts --config config.yaml
# If credits run out mid-run, just re-run — already-processed chunks are skipped.
```
