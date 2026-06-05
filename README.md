# Knowledge Graph Generator (kg-gen)

> Transform any file collection into an intelligent knowledge graph using local LLMs via Ollama — or any OpenAI-compatible API provider

An advanced CLI tool that analyzes files, extracts meaningful entities and relationships, and builds comprehensive knowledge graphs. Supports code, documents, PDFs, audio/video, and more. Local-first via Ollama by default, with optional OpenAI-compatible providers (OpenAI, OpenRouter, vLLM, …) and resumable runs for large jobs.

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
- **Research Ready**: Support for LoRa fine-tuning and model improvement
- **Intelligent Search**: Vector and graph-based context retrieval

## Key Features

### Core Capabilities

- **Multi-format Processing**: Text, code, Markdown, PDFs, Office docs, HTML, RTF, images, audio/video
- **Hierarchical Merging**: 3-level intelligent merging (within-chunk → within-file → cross-file)
- **Smart Chunking**: Content-aware splitting using `RecursiveCharacterTextSplitter` with configurable overlap
- **Context-Aware Processing**: Uses existing knowledge graph to maintain cross-file consistency
- **Quality Evaluation**: Structural, semantic, factual, and consistency metrics framework

### Advanced Features

- **MCP Compatibility**: Works with Claude Desktop via `mcp-jsonl` export format
- **Multiple Export Formats**: JSON, JSONL, MCP-compatible JSONL, GraphViz DOT
- **Embedding-Based Search**: Context retrieval for cross-file consistency during extraction
- **Embeddings Caching**: In-memory caching for repeated embedding calls
- **Watch Mode**: Real-time knowledge graph updates as files change
- **Document Classification**: Heuristic, BERT, or LLM-based content type detection (experimental)

### Intelligence Features

- **Zero Hallucination**: Strict prompt guidelines with factual grounding enforcement
- **Entity Deduplication**: Jaro-Winkler similarity for entity names + cosine similarity for observations
- **Observation Ranking**: Embedding-based duplicate detection — keeps longer, more informative observations
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
# Input/Output
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
provider: ollama            # ollama | openai (OpenAI-compatible)
model: gemma3:4b
host: http://localhost:11434
contextLength: 12000
temperature: 0.1
# promptVersion: v4.5       # prompt template version (config-only; default v4.5)

# Embeddings (independent from generation)
embeddingsProvider: ollama
embeddingsModel: mxbai-embed-large:335m
embeddingsHost: http://localhost:11434

# Text Processing
chunking: enabled
chunkSize: 4000
overlapSize: 100

# Media (disable if not needed)
images: disabled
asr: disabled

# Context Retrieval
retrieval: enabled
retrievalLimit: 3

# Merging
enableSimilarityMerging: true
entitySimilarityThreshold: 0.9
observationSimilarityThreshold: 0.7

# Export
exportFormat: jsonl

# Logging
logLevel: info
debug: false
```

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
exportFormat: jsonl

# Generation on OpenRouter (host = base URL)
provider: openai
host: https://openrouter.ai/api/v1
apiKey: sk-or-...            # or set $OPENAI_API_KEY / $KG_API_KEY instead
model: google/gemma-3-27b-it

# Embeddings stay local & free
embeddingsProvider: ollama
embeddingsModel: mxbai-embed-large:335m

# Resumable: writes <output>.checkpoint.jsonl; re-run the same command to continue
resume: true
```

```bash
# Keep your key out of the file via env if you prefer:
export OPENAI_API_KEY=sk-or-...
npx ts-node ./src/index.ts --config config.yaml
# If the run dies mid-way, just run it again — finished chunks are skipped.
```

### Document Outline (`outline`, config-only)

Each file's structural outline is generated and injected into the prompt as extra context. Tune or disable it via a nested `outline:` group in `config.yaml` (no CLI flags, like `dotOptions`):

| Key | Default | Description |
| --- | ------- | ----------- |
| `enabled` | `true` | Set `false` to skip outline generation (saves prompt tokens and silences "cannot generate outline" warnings) |
| `maxDepth` | — | Limit outline nesting depth |
| `includeLineNumbers` | `false` | Include line numbers |
| `includePrivate` | `false` | Include private/internal members |
| `includeComments` | `false` | Include comments / docstrings |

```yaml
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
| `--repeat-penalty <n>` | `0.3` | Repetition penalty (Ollama only) |
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
| `--classifier <mode>` | `disabled` | Content type detection: `disabled\|heuristic\|llm\|bert`. Drives domain-specific prompt hints/examples |

### JSON Processing

`.json`/`.jsonl`/`.geojson` are handled by a token-efficient, structure-aware reader (compact re-serialization + splitting on JSON structure — array elements, the dominant array of an object like `{conversations:[…]}`, or JSONL lines — never mid-object). Malformed JSON falls back to raw text chunking.

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--json-strategy <mode>` | `structural` | `structural` (compact + split on JSON structure) or `raw` (compact + plain text split) |

Chunk size for the JSON reader can be set per-reader in `config.yaml` (defaults to the global `chunkSize`):

```yaml
jsonReader:
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
| `--export-format <format>` | `json` | `json\|jsonl\|mcp-jsonl\|dot` |

> DOT styling (`dotOptions`) is configured in YAML only — see [GraphViz DOT](#graphviz-dot---export-format-dot).

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

```json
{
  "entities": [
    {
      "name": "knowledge_graph_builder",
      "entityType": "class",
      "observations": [
        "Extracts entities and relations from file content using LLM",
        "Uses Zod schema validation for structured LLM output",
        "Supports retry logic with exponential backoff (3 attempts)"
      ],
      "files": ["src/core/knowledge/KnowledgeGraphBuilder.ts"],
      "chunk": 1,
      "totalChunks": 3
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

#### DOT styling options (`dotOptions`)

These are **config-only** (nested under `dotOptions:` in `config.yaml`; there are no CLI flags for them). All keys are optional — defaults are shown below.

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
exportFormat: dot
dotOptions:
  layout: dot
  rankdir: LR
  colorScheme: code
  includeObservations: true
  maxObservationsPerNode: 5
  clusterByFile: true
  showLegend: true
```

## Quality Metrics

Located in `/test/` — a standalone evaluation framework for assessing extraction quality (not automated tests):

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
- Training data generation for LoRa fine-tuning

## Local LLM Requirements & Leaderboard

All tested on knowledge graph extraction quality. Smaller models trade quality for speed:

| Model | Params | Quality | Speed | Notes |
| ----- | ------ | ------- | ----- | ----- |
| `qwen3:8b` | 8B | ⭐⭐⭐⭐⭐ | Slower | Highest extraction quality |
| `gemma3:4b` | 4B | ⭐⭐⭐⭐ | Medium | Best quality/speed balance |
| `qwen2.5-coder:1.5b` | 1.5B | ⭐⭐⭐ | Fast | Excellent for source code |
| `qwen3:1.7b` | 1.7B | ⭐⭐⭐ | Fast | Good general purpose |
| `gemma3:1b` | 1B | ⭐⭐ | Very Fast | Minimal resources |
| `qwen3:0.6b` | 0.6B | ⭐ | Fastest | Minimal resources only |

For embeddings: `mxbai-embed-large:335m` is the default and recommended model.

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

const container = await ContainerFactory.create(options);
const processor = container.get<IDirectoryProcessor>(TYPES.DirectoryProcessor);
await processor.processDirectory(options);
```

## Architecture

```text
src/
├── cli/              # Commander.js CLI (40+ options, process/watch/export commands)
├── core/
│   ├── di/           # Async DI container + service registrations
│   ├── processor/    # File readers (11 types) + text chunking + classifiers
│   ├── llm/          # Ollama service, embeddings, versioned Handlebars prompt templates
│   ├── knowledge/    # KG building (LLM+Zod), 3-level hierarchical merging, vector search
│   └── export/       # Strategy pattern: json, jsonl, mcp-jsonl, GraphViz DOT
├── types/            # TypeScript interfaces and data models
└── shared/           # Logger (tslog), utilities (Jaro-Winkler, cosine similarity, config)

scripts/              # Quality metrics evaluation framework
examples/             # Sample integrations and output files
```

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

GPL-3.0 License — see [LICENSE](LICENSE) file for details.

## Acknowledgments

- **Anthropic** for MCP protocol and Claude integration inspiration
- **Ollama** for local LLM deployment and API
- **LangChain** for text splitting utilities (`@langchain/textsplitters`)
- **OpenAI Whisper** (via `nodejs-whisper`) for audio transcription
- **Open Source Community** for the amazing tools and libraries that make this possible

---

**Built with ❤️ for developers, researchers, and knowledge workers who want to understand their data better.**
