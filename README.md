# Knowledge Graph Generator (kg-gen)

> Transform any file collection into an intelligent knowledge graph using local LLMs via Ollama — or any OpenAI-compatible API provider

An advanced CLI tool that analyzes files, extracts meaningful entities and relationships, and builds comprehensive knowledge graphs. Supports code, documents, PDFs, audio/video, transcripts, and more. Local-first via Ollama by default, with optional OpenAI-compatible providers (OpenAI, OpenRouter, vLLM, …) and resumable runs for large jobs.

Facts carry **provenance and a bi-temporal axis**, an inline **grounding gate** filters hallucinations, and the graph **interops with existing memory stores** (drop-in for the official MCP memory server) and exports **KBLaM/LoRA** training data — kg-gen is a research/learning platform as much as a CLI.

## Project Goals

**Primary Objective**: Create the most intelligent file-to-knowledge-graph converter that:

- **Zero Hallucination**: Only extracts factually verifiable information
- **Semantic Understanding**: Goes beyond syntax to capture meaning and relationships
- **Scalable Processing**: Handles large codebases with smart chunking and caching
- **Multiple Formats**: Supports code, documentation, research papers, and more
- **Production Ready**: Reliable, fast, and integrates with existing workflows

**Secondary Objectives**:

- **MCP Integration**: Compatible with Claude Desktop and Anthropic MCP protocol
- **Quality Metrics**: Comprehensive evaluation system for continuous improvement
- **Research Ready**: KBLaM-format triples + quality-filtered LoRA/SFT datasets exported straight from extracted graphs
- **Intelligent Search**: Vector and graph-based context retrieval

## Key Features

### Core Capabilities

- **Multi-format Processing**: Text, code, Markdown, PDFs, Office docs, HTML, RTF, images, audio/video
- **Hierarchical Merging**: 3-level intelligent merging (within-chunk → within-file → cross-file)
- **Smart Chunking**: Content-aware splitting using `RecursiveCharacterTextSplitter` with configurable overlap
- **Context-Aware Processing**: Uses existing knowledge graph to maintain cross-file consistency
- **Quality Evaluation**: Structural, semantic, factual, and consistency metrics framework

### Advanced Features

- **Memory-store interop**: `mcp-jsonl` is byte-compatible with the official [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) — point it at the output and query your graph from Claude Code/Desktop. No store to build.
- **Multiple export formats**: JSON, JSONL, MCP-compatible JSONL, GraphViz DOT, plus **KBLaM** / **LoRA** / **Graphiti** for fine-tuning and temporal-KG ingestion (see [Output Formats](#output-formats))
- **Transcript-aware ingestion**: speaker-labeled transcripts (recua `*.parakeet.txt`, recua turns JSON, Claude/ChatGPT chat exports) are parsed into **speaker-pure chunks** so a speaker becomes per-fact provenance, not an entity
- **Embedding-Based Search**: Context retrieval for cross-file consistency during extraction
- **Embeddings Caching**: In-memory caching for repeated embedding calls
- **Watch Mode**: Real-time knowledge graph updates as files change
- **Document Classification**: Heuristic or LLM-based content type detection (experimental) — also scopes the `entityType` to an enforced per-domain enum

### Intelligence Features

- **Provenance & bi-temporal facts**: every observation carries `speaker`/`source` and a Graphiti-style bi-temporal axis (`validAt`/`invalidAt` + `createdAt`/`expiredAt`) — see [Data Model](#standard-json---export-format-json)
- **Inline grounding gate**: each extracted fact is scored against its source chunk; ungrounded "hallucinations" can be flagged or dropped before they reach the output (`--grounding`)
- **Corpus glossary pre-pass** *(experimental)*: an optional pass over the whole corpus counts term frequency, classifies once (cached), and asks the LLM for a corpus-specific glossary of canonical entity names/types/relation types. Under the v5 prompts this glossary is **authoritative** — its types and predicates become the closed vocabularies that constrain extraction, so the merged graph doesn't fragment into hundreds of one-off types (`--corpus-profiling`)
- **Provenance-preserving merge**: the same fact from two speakers/sources stays as two attributed observations, never one flattened string
- **Entity Deduplication**: Jaro-Winkler similarity for entity names + cosine similarity for observations
- **Cross-file Consistency**: Retrieval-augmented prompting maintains entity naming across files

## Installation

### Prerequisites

- **Node.js** 18+
- **[Ollama](https://ollama.ai)** running locally — required for the default local path and for local embeddings. Optional only if you point **both** generation and embeddings at an OpenAI-compatible provider.

```bash
# Clone the repository
git clone https://github.com/alex_sabaka/kg-gen
cd kg-gen
npm install

# Pull required Ollama models
ollama pull llama3.2                    # Default LLM
ollama pull mxbai-embed-large:335m     # Default embeddings model

# Build (optional, can use ts-node directly)
npm run build
```

## Usage

### Basic Usage

```bash
# Process current directory with defaults
npx ts-node ./src/index.ts -i ./my-project -o knowledge-graph.json

# Specify model and output format
npx ts-node ./src/index.ts -i ./src -m qwen3:8b --export-format jsonl -o kg.jsonl

# Using a configuration file (recommended)
npx ts-node ./src/index.ts --config config.yaml
```

### Configuration File (Recommended)

Create a `config.yaml`:

```yaml
# Input/Output (top-level)
input: ./my-project
filter:
  - "**/*.ts"
  - "**/*.md"
exclude:
  - "**/node_modules/**"
  - "**/dist/**"
output: knowledge-graph.jsonl
description: "TypeScript project source code"

# LLM
llm:
  provider: ollama            # ollama | openai (OpenAI-compatible)
  model: gemma3:4b
  host: http://localhost:11434
  contextLength: 12000
  temperature: 0.1
  # promptVersion: v5         # prompt template version (also --prompt-version; default v5, use v4.5 for legacy)

# Embeddings (independent from generation)
embeddings:
  provider: ollama
  model: mxbai-embed-large:335m
  host: http://localhost:11434

# Text Processing
chunking:
  mode: enabled
  size: 4000
  overlap: 100

# Media (disable if not needed)
readers:
  images: disabled
  asr:
    mode: disabled

# Context Retrieval
retrieval:
  mode: enabled
  limit: 3

# Merging
merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.9
  observationSimilarityThreshold: 0.7

# Export
export:
  format: jsonl

# Logging
logging:
  level: info
  debug: false
```

> The config file uses a **nested** shape (the single source of truth is the Zod
> schema in `src/config/`). CLI flags stay flat (`--chunk-size`). Run `node
> ./dist/index.js schema` to print the full JSON Schema. Migrating an old flat
> config? See [docs/MIGRATION.md](./docs/MIGRATION.md).

Then run:

```bash
npx ts-node ./src/index.ts --config config.yaml
```

### Using a Cloud Provider (OpenAI-compatible) + Resume

Point generation at any OpenAI-compatible endpoint by setting `provider: openai` and using `host` as the base URL. Keep embeddings local (the default) so dedup/merge stays free. Enable `resume` for large jobs so an interrupted run (e.g. credits exhausted) can continue without reprocessing.

```yaml
input: ./claude-chats-export
filter:
  - "**/*.json"
output: knowledge-graph.jsonl
export:
  format: jsonl

# Generation on OpenRouter (host = base URL)
llm:
  provider: openai
  host: https://openrouter.ai/api/v1
  apiKey: sk-or-...            # or set $OPENAI_API_KEY / $KG_API_KEY instead
  model: google/gemma-3-27b-it

# Embeddings stay local & free
embeddings:
  provider: ollama
  model: mxbai-embed-large:335m

# Resumable: writes <output>.checkpoint.jsonl; re-run the same command to continue
resume:
  enabled: true
```

```bash
# Keep your key out of the file via env if you prefer:
export OPENAI_API_KEY=sk-or-...
npx ts-node ./src/index.ts --config config.yaml
# If the run dies mid-way, just run it again — finished chunks are skipped.
```

### Document Outline (`readers.outline`, config-only)

Each file's structural outline is generated and injected into the prompt as extra context. Tune or disable it via the nested `readers.outline:` group in `config.yaml` (no CLI flags, like `export.dot`):

| Key | Default | Description |
| --- | ------- | ----------- |
| `enabled` | `true` | Set `false` to skip outline generation (saves prompt tokens and silences "cannot generate outline" warnings) |
| `maxDepth` | — | Limit outline nesting depth |
| `includeLineNumbers` | `false` | Include line numbers |
| `includePrivate` | `false` | Include private/internal members |
| `includeComments` | `false` | Include comments / docstrings |

```yaml
readers:
  outline:
    enabled: true
    maxDepth: 3
```

### Watch Mode

```bash
# Continuously update knowledge graph as files change
npx ts-node ./src/index.ts --config config.yaml --watch
```

### Advanced Usage

```bash
# Process multimedia project (images + audio transcription)
npx ts-node ./src/index.ts -i ./media-project \
  --images enabled \
  --asr enabled \
  --whisper-model medium \
  -m llava:7b

# Export as GraphViz DOT for visualization
npx ts-node ./src/index.ts -i ./src \
  --export-format dot \
  -o graph.dot

# Render with GraphViz
dot -Tsvg graph.dot -o graph.svg
```

## CLI Options

### Core Processing

| Option | Default | Description |
| ------ | ------- | ----------- |
| `-i, --input <path>` | `.` | Input directory |
| `-f, --filter <filter>` | `**/*` | Include file pattern |
| `-e, --exclude <filter...>` | — | Exclude patterns |
| `-o, --output <path>` | `knowledge-graph.json` | Output file |
| `-d, --description <text>` | — | Content description for LLM context |
| `--config <file>` | — | YAML/JSON configuration file |

### LLM Configuration

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--provider <name>` | `ollama` | Generation backend: `ollama` or `openai` (any OpenAI-compatible endpoint) |
| `-m, --model <name>` | `llama3.2` | Model name (Ollama tag, or provider model id like `google/gemma-3-27b-it`) |
| `-h, --host <url>` | `http://localhost:11434` | Ollama host, or OpenAI-compatible **base URL** when `--provider openai` |
| `--api-key <key>` | — | API key for the OpenAI-compatible provider (falls back to `$OPENAI_API_KEY` / `$KG_API_KEY`) |
| `--temperature <n>` | `0.1` | Sampling temperature |
| `--repeat-penalty <n>` | `1.1` | Repetition penalty, Ollama only (>1.0 discourages repetition, <1.0 promotes it, 1.0 = off) |
| `--context-length <n>` | `8192` | Context window size (Ollama only) |
| `--max-tokens <n>` | provider default | Max output tokens per generation. Raise it (or lower `--chunk-size`) if large knowledge-graph JSON gets truncated mid-output |
| `--seed <n>` | — | Random seed for reproducibility (Ollama only) |
| `-s, --system <prompt\|path>` | — | Custom system prompt or Handlebars template path |

### Embeddings Configuration

Embeddings (used for dedup and context retrieval) are configured independently from generation, so you can keep them local and free while generation runs on a cloud provider.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--embeddings-provider <name>` | `ollama` | Embeddings backend: `ollama` or `openai` |
| `--embeddings-model <name>` | `mxbai-embed-large:335m` | Embeddings model |
| `--embeddings-host <url>` | `http://localhost:11434` | Embeddings host / OpenAI-compatible base URL |
| `--embeddings-api-key <key>` | — | API key for OpenAI-compatible embeddings (falls back to `$OPENAI_API_KEY` / `$KG_API_KEY`) |
| `--embeddings-max-input-chars <n>` | `1024` | Truncate embedding inputs to at most N chars (auto-shrinks further if the model still rejects them). Safe default for 512-token models like mxbai; raise for large-context cloud models |

### Text Processing

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--chunking <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `-c, --chunk-size <n>` | `2000` | Max chunk size (characters) |
| `--overlap-size <n>` | `100` | Overlap between chunks |

### Audio/Video (Whisper ASR)

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--asr <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `--whisper-model <name>` | `medium` | Whisper model size (`tiny`\|`base`\|`small`\|`medium`\|`large`) |
| `--language <lang>` | `auto` | Language code or `auto` |
| `--translate` | `false` | Translate audio to English |

### Image & Document Processing

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--images <mode>` | `auto` | `enabled\|disabled\|auto` (requires vision-capable model) |
| `--docling` | `false` | Use Docling for advanced PDF/Office parsing |

### Content Classification (experimental)

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--classifier <mode>` | `disabled` | Content type detection: `disabled\|heuristic\|llm`. Drives domain-specific prompt hints/examples **and** scopes the extracted `entityType` to an enforced per-domain Zod enum (the domain's types + generics + `other`) |

### JSON Processing

`.json`/`.jsonl`/`.geojson` are handled by a token-efficient, structure-aware reader (compact re-serialization + splitting on JSON structure — array elements, the dominant array of an object like `{conversations:[…]}`, or JSONL lines — never mid-object). Malformed JSON falls back to raw text chunking.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--json-strategy <mode>` | `structural` | `structural` (compact + split on JSON structure) or `raw` (compact + plain text split) |

Chunk size for the JSON reader can be set per-reader in `config.yaml` (defaults to the global `chunking.size`):

```yaml
readers:
  json:
    strategy: structural
    maxChunkSize: 8000
```

### Context Retrieval

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--retrieval <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `--retrieval-limit <n>` | `3` | Max retrieved context entities per chunk |
| `--retrieval-scope <mode>` | `chunk` | `chunk` (retrieve per chunk using its own content) or `file` (retrieve once from the first chunk, reuse for all) |

### Merging

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--entity-similarity-threshold <n>` | `0.9` | Jaro-Winkler entity dedup threshold (0–1) |
| `--observation-similarity-threshold <n>` | `0.9` | Embedding similarity threshold (0–1) |
| `--enable-similarity-merging` | `true` | Enable intelligent entity deduplication |

### Export

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--export-format <format>` | `json` | `json\|jsonl\|mcp-jsonl\|dot\|kblam\|lora\|graphiti` |
| `--export-only` | `false` | Convert an existing knowledge-graph JSON file (`--input`) to `--export-format`, written to `--output` — no extraction. Handy for producing `kblam`/`lora`/`graphiti`/`mcp-jsonl` from a graph you already built |

> DOT styling (`export.dot`) is configured in YAML only — see [GraphViz DOT](#graphviz-dot---export-format-dot).

```bash
# Re-export an existing graph to KBLaM training triples (no LLM calls)
npx ts-node ./src/index.ts --export-only \
  -i ./knowledge-graph.json --export-format kblam -o ./kb.jsonl
```

### Inline Grounding Gate

Each extracted observation is scored against its source chunk (keyword overlap); ungrounded "hallucinations" can be flagged or dropped before they reach the output, the checkpoint, or the merge.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--grounding <mode>` | `disabled` | `disabled` · `flag` (annotate each observation with `grounded`/`groundingScore`, keep all) · `drop` (remove observations below the threshold) |
| `--grounding-min-score <n>` | `0.5` | Minimum keyword-overlap score (0–1) an observation must reach. Also gates which facts the `lora` export keeps |

### Corpus Analysis (experimental)

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--corpus-profiling <mode>` | `disabled` | `disabled` · `enabled` — run a pre-pass that counts term frequency, classifies once (cached), and asks the LLM for a corpus-specific glossary (canonical entity names/types/relation types). Under v5 the glossary is **authoritative**: its types/predicates become the closed extraction vocabularies |
| `--prompt-version <version>` | `v5` | Prompt template set under `templates/` (`v5` = closed-vocabulary + topology-hygiene default; `v4.5` = legacy). Also settable via config `promptVersion` |
| `--corpus-top-terms <n>` | `100` | Number of most-frequent terms fed to the glossary call |
| `--corpus-profile-path <path>` | `<output>.corpus-profile.json` | Cached profile sidecar path (reused on re-run when the corpus + model are unchanged) |

### Resume / Continuation

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--resume` | `false` | Checkpoint each processed chunk and skip already-done chunks on re-run (survives interrupted / credit-exhausted runs) |
| `--checkpoint <path>` | `<output>.checkpoint.jsonl` | Checkpoint sidecar file path |

**Graceful interrupt:** pressing **Ctrl+C** (or Ctrl+D / `SIGTERM`) once finishes the in-flight chunk, checkpoints it, then merges and writes the **partial** graph before exiting — so you never lose a chunk you already paid for. Press again to force-quit. Combine with `--resume` to continue later.

**What invalidates resume:** a chunk is reused only when its **file content, chunk size/overlap, model, and prompt version** all match the run that created it — these are folded into the checkpoint key. Changing any of them (e.g. switching models or `--chunk-size` while tuning) means those chunks are re-extracted. The file is identified by its path **relative to `--input`**, so **relocating the whole input tree (or changing the `--input` prefix) keeps your checkpoint valid** — handy when you reorganize data folders; only renaming a file *within* the tree re-runs that one file. On load, kg-gen reports how many checkpointed chunks match the current model/prompt and warns if none do; delete the `.checkpoint.jsonl` sidecar to start clean.

### Logging & Runtime

| Option | Default | Description |
| ------ | ------- | ----------- |
| `-L, --log-level <level>` | `info` | `debug\|info\|warning\|error` |
| `-l, --log-file <path>` | — | Write logs to file |
| `-D, --debug` | `false` | Debug mode |
| `-S, --silent` | `false` | Suppress output |
| `-w, --watch` | `false` | Watch mode |

## Supported File Formats

| Format | Extensions | Processing |
| ------ | ---------- | ---------- |
| Plain text | `.txt`, source code files | Direct extraction |
| Markdown | `.md` | Markdown-aware parsing |
| Transcripts | `*.parakeet.txt`/`*.whisper.txt` (speaker-labeled), transcript/turn JSON, Claude/ChatGPT chat exports | Speaker-pure chunks with per-fact `speaker`/`occurredAt` provenance |
| JSON | `.json`, `.jsonl`, `.geojson` | Token-efficient, structure-aware chunking (compact, split on JSON structure) |
| Source code | `.ts`, `.js`, `.py`, `.go`, `.rs`, and more | Code-aware extraction |
| PDF | `.pdf` | Page-by-page text (or Docling for advanced) |
| Office | `.docx`, `.xlsx`, `.pptx` | Via officeparser |
| HTML | `.html`, `.htm` | Via cheerio |
| RTF | `.rtf` | RTF parsing |
| Images | `.jpg`, `.png`, `.gif`, `.webp`, `.tiff`, `.heic`, `.avif` | Vision model required |
| Audio | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.aac` | Whisper transcription |
| Video | `.mp4`, `.mkv`, `.avi`, `.webm` | Audio extraction + Whisper |

## Output Formats

### Standard JSON (`--export-format json`)

Observations are **objects**, not bare strings: each carries provenance (`source`/`speaker`) and a Graphiti-style **bi-temporal** axis — `validAt`/`invalidAt` (when the fact was true in the world) and `createdAt`/`expiredAt` (when the system learned / superseded it). The LLM still emits plain text; kg-gen stamps these deterministically from what it already knows about the chunk. Optional fields are omitted when unknown; legacy graphs with string observations still load.

```json
{
  "entities": [
    {
      "name": "knowledge_graph_builder",
      "entityType": "class",
      "observations": [
        {
          "text": "Extracts entities and relations from file content using LLM",
          "source": "src/core/knowledge/KnowledgeGraphBuilder.ts",
          "createdAt": "2026-06-05T15:57:59.856Z"
        }
      ],
      "files": ["src/core/knowledge/KnowledgeGraphBuilder.ts"],
      "chunk": 1,
      "totalChunks": 3
    },
    {
      "name": "SPEAKER_01",
      "entityType": "person",
      "observations": [
        {
          "text": "Explains that a Naïve Bayes classifier assumes word independence",
          "speaker": "SPEAKER_01",
          "source": "Olga Lesson P.parakeet.txt",
          "validAt": "2026-05-28T00:00:00Z",
          "createdAt": "2026-06-05T15:57:59.856Z"
        }
      ],
      "files": ["Olga Lesson P.parakeet.txt"]
    }
  ],
  "relations": [
    {
      "from": "knowledge_graph_builder",
      "to": "ollama_service",
      "relationType": ["uses", "depends_on"]
    }
  ]
}
```

### MCP-Compatible JSONL (`--export-format mcp-jsonl`)

```jsonl
{"type":"entity","name":"knowledge_graph_builder","entityType":"class","observations":["Extracts entities and relations from file content using LLM"]}
{"type":"relation","from":"knowledge_graph_builder","to":"ollama_service","relationType":"uses,depends_on"}
```

### GraphViz DOT (`--export-format dot`)

Renders a styled, colored graph with one node per entity (label = name + truncated observations + type + source file), colored edges per relation type, a title, a legend, and a "Processing Configuration" summary cluster. Render it with GraphViz:

```bash
npx ts-node ./src/index.ts -i ./src --export-format dot -o graph.dot
dot -Tsvg graph.dot -o graph.svg          # or: neato/fdp/sfdp/circo/twopi
```

#### DOT styling options (`export.dot`)

These are **config-only** (nested under `export.dot:` in `config.yaml`; there are no CLI flags for them). All keys are optional — defaults are shown below.

| Key | Default | Values / Description |
| --- | ------- | -------------------- |
| `layout` | `dot` | Layout engine: `dot`, `neato`, `fdp`, `sfdp`, `circo`, `twopi` |
| `rankdir` | `TB` | Graph direction: `TB`, `BT`, `LR`, `RL` |
| `nodeShape` | `box` | Any GraphViz node shape (`box`, `ellipse`, `circle`, …) |
| `edgeStyle` | `solid` | Edge style (`solid`, `dashed`, `dotted`, `bold`) |
| `colorScheme` | `default` | Palette: `default`, `scientific`, `code`, `minimal` |
| `includeObservations` | `true` | Show entity observations inside node labels (truncated to ~40 chars) |
| `maxObservationsPerNode` | `3` | Max observations per node; the remainder is summarized as `... +N more` |
| `clusterByEntityType` | `false` | Group same-type entities into dashed subgraph clusters (needs ≥2 of a type; ignored when `clusterByFile` is on) |
| `clusterByFile` | `false` | Group same-file entities into clusters (needs ≥2 per file; takes precedence over `clusterByEntityType`) |
| `showLegend` | `true` | Render a legend of entity types and relation types |

```yaml
# config.yaml
export:
  format: dot
  dot:
    layout: dot
    rankdir: LR
    colorScheme: code
    includeObservations: true
    maxObservationsPerNode: 5
    clusterByFile: true
    showLegend: true
```

### KBLaM Triples (`--export-format kblam`)

JSONL in the shape Microsoft [KBLaM](https://github.com/microsoft/KBLaM)'s `dataset_generation` ingests — one `(entity, property, value)` `DataPoint` per line, with the derived `Q`/`A`/`key_string` it encodes into knowledge tokens. Observations become `(entity, "fact", text)`; relations become `(from, relationType, to)`.

```jsonl
{"name":"Recursion","description_type":"fact","description":"a function that calls itself","Q":"What is the fact of Recursion?","A":"The fact of Recursion is a function that calls itself.","key_string":"the fact of Recursion"}
{"name":"Recursion","description_type":"terminates_at","description":"BaseCase","Q":"What is the terminates_at of Recursion?","A":"The terminates_at of Recursion is BaseCase.","key_string":"the terminates_at of Recursion"}
```

### LoRA / SFT Dataset (`--export-format lora`)

Chat-format instruction examples (`{messages:[user Q, assistant A]}`) derived from the same triples, **quality-filtered**: observations whose grounding score (from `--grounding`) is below `--grounding-min-score` are dropped, so only grounded facts make it into training data.

```jsonl
{"messages":[{"role":"user","content":"What is the fact of Recursion?"},{"role":"assistant","content":"The fact of Recursion is a function that calls itself."}]}
```

### Graphiti (`--export-format graphiti`)

`add_triplet`-shaped `{ nodes: EntityNode[], edges: EntityEdge[] }` for ingestion into a [Graphiti](https://github.com/getzep/graphiti) temporal knowledge graph — entities → nodes (summary built from observations, `created_at`), relations → edges (`UPPER_SNAKE` name, stable sha1 uuids). Per-fact valid-time is carried in the `json`/`kblam` exports.

## Quality Metrics

Located in `src/quality/` — importable evaluators (also wired into the `npm run benchmark` harness in `src/evaluation/`) for assessing extraction quality. The `factual` evaluator additionally backs the inline [grounding gate](#inline-grounding-gate):

### Structural Metrics

- Entity and relation counts
- Graph density and connectivity
- Type distribution analysis

### Semantic Metrics

- Entity name quality (naming conventions, descriptiveness)
- Observation specificity (detailed vs. trivial facts)
- Domain coverage (how well it captures file content)

### Factual Metrics

- Hallucination detection (ungrounded claims)
- Source grounding (facts verifiable in source)
- Factual consistency (no contradictions)

### Consistency Metrics

- Cross-file consistency (entity naming)
- Type consistency (similar entities get similar types)

### Composite Score

- Overall quality score (0–100)
- Specific recommendations for improvement
- Composite score gates which graphs are harvested for fine-tuning data (`--export-format kblam`/`lora`)

## Local LLM Requirements & Leaderboard

Qualitative guidance for local model selection (quality/speed trade-off). For
measured P/R/F1 see the benchmark table below.

| Model | Params | Quality | Speed | Notes |
| ----- | ------ | ------- | ----- | ----- |
| `qwen3:8b` | 8B | ⭐⭐⭐⭐⭐ | Slower | Highest extraction quality |
| `gemma3:4b` | 4B | ⭐⭐⭐⭐ | Medium | Best quality/speed balance |
| `qwen2.5-coder:1.5b` | 1.5B | ⭐⭐⭐ | Fast | Excellent for source code |
| `qwen3:1.7b` | 1.7B | ⭐⭐⭐ | Fast | Good general purpose |
| `gemma3:1b` | 1B | ⭐⭐ | Very Fast | Minimal resources |
| `qwen3:0.6b` | 0.6B | ⭐ | Fastest | Minimal resources only |

For embeddings: `mxbai-embed-large:335m` is the default and recommended model.

### Measured benchmark (CrossRE)

Re-run after the sampling fix (temperature reaches the model; seed wired).
Dataset **CrossRE `ai-test`**, n = 17–20 samples (samples that failed extraction
were excluded, not scored as zero); prompt **v5**; generation via **OpenRouter
(cloud)**; matching via local `mxbai-embed-large:335m` at semantic threshold
0.80. *Indicative, not definitive — small n, single domain, cloud inference.*
(2026-06-11; reproduce with `npm run benchmark -- --provider openai --host https://openrouter.ai/api/v1 --model <id> --dataset crossre --data-path ./data/crossre/crossre_data/ai-test.json --limit 20 --prompt-version v5 --request-delay 2500`)

| Model | n | Entity F1 (sem) | Relation F1 (sem) | Triple F1 (sem) | Intrinsic |
| ----- | - | --------------- | ----------------- | --------------- | --------- |
| `qwen3-14b` | 17 | **0.851** | 0.130 | 0.037 | 83.9 |
| `qwen3-8b` | 19 | 0.808 | 0.187 | 0.019 | 82.0 |
| `gemma-3-4b-it` | 20 | 0.807 | 0.198 | 0.036 | 83.4 |
| `gemma-3-27b-it` | 20 | 0.767 | **0.211** | **0.070** | 82.8 |
| `gemma-3-12b-it` | 20 | 0.716 | 0.093 | 0.019 | 74.7 |

**The "small Gemma beats larger Gemmas" finding holds under corrected sampling:**
`gemma-3-4b-it` (Entity F1 0.807, intrinsic 83.4) outperforms both
`gemma-3-12b-it` and `gemma-3-27b-it` on entity extraction, and is near-tied for
2nd of 5 overall (behind `qwen3-14b`, level with `qwen3-8b`). Relation/triple F1
are uniformly low — CrossRE relation extraction is hard under strict matching.
The original sub-4B local models (`gemma3:1b`, `qwen3:0.6b`, …) aren't hosted on
OpenRouter, so they're absent from this cloud re-run; benchmark them locally with
`--provider ollama`.

## Integration Examples

### kg-mail-assistant

See `examples/kg-mail-assistant/` for a complete real-world integration:

- Gmail OAuth2 integration with email filtering
- Telegram bot interface
- Continuous email-to-KG pipeline
- Sample output graphs in `examples/kg-mail-assistant/data/graphs/`

### Programmatic Usage

```typescript
import { ContainerFactory } from './src/core/di/ContainerFactory';
import { TYPES } from './src/core/di';
import { IDirectoryProcessor } from './src/types';

const options = {
  input: './my-project',
  output: 'knowledge-graph.json',
  model: 'gemma3:4b',
  host: 'http://localhost:11434',
  // ... see ProcessingOptions for all fields
};

const container = ContainerFactory.createContainer({ processingOptions: options });
const processor = await container.resolve<IDirectoryProcessor>(TYPES.DirectoryProcessor);
await processor.processDirectory(options);
```

## Architecture

```text
src/
├── cli/              # Commander.js CLI (process/watch/export commands; --export-only)
├── core/
│   ├── di/           # Async DI container + service registrations
│   ├── processor/    # File readers (transcript, JSON, PDF, Office, audio, …) + chunking + classifiers
│   ├── checkpoint/   # Per-chunk resume sidecar (--resume)
│   ├── llm/          # Ollama / OpenAI-compatible providers, embeddings, Handlebars prompt templates
│   ├── knowledge/    # KG building (LLM+Zod, provenance + grounding gate), 3-level merge, vector search
│   └── export/       # Strategy pattern: json, jsonl, mcp-jsonl, dot, kblam, lora, graphiti
├── quality/          # Importable quality metrics (structural, semantic, factual, consistency, composite)
├── evaluation/       # Benchmark harness (CrossRE / REBEL / RE-DocRED) — `npm run benchmark`
├── types/            # TypeScript interfaces and data models (KnowledgeGraph, Observation, …)
└── shared/           # Logger (tslog), graceful shutdown, utilities (Jaro-Winkler, cosine similarity, config)

scripts/              # Standalone benchmark CLI + report tooling
examples/             # Sample integrations and output files
```

Tests use Jest (`npm test`); mock the LLM via the `ILLMProvider` interface for network-free unit tests.

## Development Setup

```bash
git clone https://github.com/alex_sabaka/kg-gen
cd kg-gen
npm install

# Run directly (development)
npx ts-node ./src/index.ts --config config.yaml

# Build to dist/
npm run build

# Run compiled
node ./dist/index.js --config config.yaml
```

## License

MIT License — see [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Anthropic** for MCP protocol and Claude integration inspiration
- **Ollama** for local LLM deployment and API
- **LangChain** for text splitting utilities (`@langchain/textsplitters`)
- **OpenAI Whisper** (via `nodejs-whisper`) for audio transcription
- **Open Source Community** for the amazing tools and libraries that make this possible

---

**Built with ❤️ for developers, researchers, and knowledge workers who want to understand their data better.**
