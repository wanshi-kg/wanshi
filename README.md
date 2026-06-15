# ![Wan Shi](./docs/assets/readme-banner.png)

> A local-first CLI that reads ten thousand things — code, docs, PDFs, audio, transcripts — and builds one knowledge graph that remembers where every fact came from.

`wanshi` extracts entities and relations from a file tree and merges them into a single graph. It runs on local models via [Ollama](https://ollama.ai) by default, or any OpenAI-compatible endpoint. Facts carry provenance and a bi-temporal axis, an inline grounding gate filters ungrounded claims, and the graph is a drop-in producer for the MCP memory server, Graphiti, and KBLaM/LoRA training exports.

It's a working CLI and a research platform in equal measure — the long game is domain-tuned extraction feeding knowledge injection into small local models.

---

> **Command shorthand:** examples below write `wanshi` for the run command. Until the npm package ships, that's `npx ts-node ./src/index.ts` (dev) or `node ./dist/index.js` (built). Once published, it's literally `wanshi`.

## What's distinctive

Most text→KG tools stop at "extract triples." `wanshi` is built around the parts that come after:

- **Provenance, not just facts.** Every observation records its `source`/`speaker` and a Graphiti-style bi-temporal axis (`validAt`/`invalidAt` for world-time, `createdAt`/`expiredAt` for system-time). The same fact from two speakers stays as two attributed observations, never one flattened string.
- **A grounding gate.** Each extracted fact is scored against its source chunk and can be flagged or dropped before it reaches the output — keyword overlap as a cheap pre-filter, with an optional local NLI checker (MiniCheck) for the uncertain cases. It won't record what it can't verify against the source.
- **Closed-vocabulary extraction.** An optional corpus pre-pass builds a glossary of canonical entity/relation types, which then *constrains* extraction — so a large corpus doesn't fragment into hundreds of one-off types.
- **Transcript-aware ingestion.** Speaker-labeled transcripts and chat exports are split into speaker-pure chunks, so a speaker becomes per-fact provenance rather than a polluting entity.
- **Memory-store interop.** `mcp-jsonl` output is byte-compatible with the official [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) — point it at the file and query your graph from Claude Code/Desktop. No store to build.
- **Training-data exports.** Emit KBLaM `(entity, property, value)` triples or quality-filtered LoRA/SFT chat examples straight from a graph.
- **Resumable runs.** Per-chunk checkpoints survive interrupts and exhausted API credits; re-run the same command to continue.

## Supported inputs

| Format | Extensions | Handling |
| ------ | ---------- | -------- |
| Text / source code | `.txt`, `.ts`, `.js`, `.py`, `.go`, `.rs`, … | Direct / code-aware extraction |
| Markdown | `.md` | Markdown-aware parsing |
| Transcripts | speaker-labeled `*.parakeet.txt`/`*.whisper.txt`, transcript/turn JSON, Claude/ChatGPT exports | Speaker-pure chunks with per-fact `speaker`/`occurredAt` |
| JSON | `.json`, `.jsonl`, `.geojson` | Structure-aware chunking (splits on JSON structure, never mid-object) |
| PDF | `.pdf` | Page text, or Docling for advanced parsing |
| Office | `.docx`, `.xlsx`, `.pptx` | Via officeparser |
| HTML / RTF | `.html`, `.htm`, `.rtf` | cheerio / RTF parsing |
| Images | `.jpg`, `.png`, `.gif`, `.webp`, `.tiff`, `.heic`, `.avif` | Vision model required |
| Audio / Video | `.mp3`, `.wav`, `.m4a`, `.flac`, `.mp4`, `.mkv`, `.webm`, … | Whisper transcription |

## Install

Requires **Node.js 18+** and **[Ollama](https://ollama.ai)** running locally (needed for the default local generation + embeddings path; optional only if you point *both* at an OpenAI-compatible provider).

```bash
git clone https://github.com/AlexSabaka/wanshi
cd wanshi
npm install

# Default local models
ollama pull llama3.2                 # generation
ollama pull mxbai-embed-large:335m   # embeddings

npm run build   # optional; ts-node works directly
```

## Quick start

```bash
# Process a directory with defaults
wanshi -i ./my-project -o knowledge-graph.json

# Pick a model and output format
wanshi -i ./src -m qwen3:8b --export-format jsonl -o kg.jsonl

# Config file (recommended for anything non-trivial)
wanshi --config config.yaml
```

### Configuration

The config file uses a **nested** shape (the source of truth is the Zod schema in `src/config/`); CLI flags stay flat. Run `wanshi schema` to print the full JSON Schema.

```yaml
input: ./my-project
filter: ["**/*.ts", "**/*.md"]
exclude: ["**/node_modules/**", "**/dist/**"]
output: knowledge-graph.jsonl
description: "TypeScript project source code"

llm:
  provider: ollama          # ollama | openai (OpenAI-compatible)
  model: gemma3:4b
  host: http://localhost:11434
  contextLength: 12000
  temperature: 0.1

embeddings:                 # independent from generation — keep local & free
  provider: ollama
  model: mxbai-embed-large:335m
  host: http://localhost:11434

chunking: { mode: enabled, size: 4000, overlap: 100 }
retrieval: { mode: enabled, limit: 3 }

merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.9
  observationSimilarityThreshold: 0.7

export: { format: jsonl }
```

### Cloud generation + resume

Point generation at any OpenAI-compatible endpoint (`provider: openai`, `host` = base URL), keep embeddings local so dedup/merge stays free, and enable `resume` so an interrupted run continues without reprocessing.

```yaml
llm:
  provider: openai
  host: https://openrouter.ai/api/v1
  apiKey: sk-or-...          # or $OPENAI_API_KEY / $WANSHI_API_KEY
  model: google/gemma-3-27b-it
embeddings:
  provider: ollama
  model: mxbai-embed-large:335m
resume:
  enabled: true             # writes <output>.checkpoint.jsonl
```

If the run dies mid-way, just run the same command again — finished chunks are skipped. **Ctrl+C once** finishes the in-flight chunk, checkpoints it, and writes the partial graph before exiting; press again to force-quit.

A chunk is reused only when its **file content, chunk size/overlap, model, and prompt version** all match — these are folded into the checkpoint key. Files are keyed by path *relative to `--input`*, so relocating the whole tree keeps checkpoints valid; only editing a file re-runs it.

### Other modes

```bash
# Watch: update the graph as files change
wanshi --config config.yaml --watch

# Multimedia (images + audio transcription)
wanshi -i ./media --images enabled --asr enabled --whisper-model medium -m llava:7b

# GraphViz DOT for visualization
wanshi -i ./src --export-format dot -o graph.dot && dot -Tsvg graph.dot -o graph.svg

# Re-export an existing graph (no LLM calls)
wanshi --export-only -i ./knowledge-graph.json --export-format kblam -o ./kb.jsonl
```

## CLI reference

### Core

| Option | Default | Description |
| ------ | ------- | ----------- |
| `-i, --input <path>` | `.` | Input directory |
| `-f, --filter <glob>` | `**/*` | Include pattern |
| `-e, --exclude <glob...>` | — | Exclude patterns |
| `-o, --output <path>` | `knowledge-graph.json` | Output file |
| `-d, --description <text>` | — | Content description for LLM context |
| `--config <file>` | — | YAML/JSON config file |

### LLM

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--provider <name>` | `ollama` | `ollama` or `openai` (any OpenAI-compatible endpoint) |
| `-m, --model <name>` | `llama3.2` | Ollama tag or provider model id |
| `-h, --host <url>` | `http://localhost:11434` | Ollama host, or OpenAI-compatible base URL |
| `--api-key <key>` | — | Falls back to `$OPENAI_API_KEY` / `$WANSHI_API_KEY` |
| `--temperature <n>` | `0.1` | Sampling temperature |
| `--repeat-penalty <n>` | `1.1` | Ollama only (>1.0 discourages repetition) |
| `--context-length <n>` | `8192` | Context window (Ollama only) |
| `--max-tokens <n>` | provider default | Raise (or lower `--chunk-size`) if graph JSON truncates mid-output |
| `--seed <n>` | — | Reproducibility seed (Ollama only) |
| `-s, --system <prompt\|path>` | — | Custom system prompt or template path |

### Embeddings (independent from generation)

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--embeddings-provider <name>` | `ollama` | `ollama` or `openai` |
| `--embeddings-model <name>` | `mxbai-embed-large:335m` | Embeddings model |
| `--embeddings-host <url>` | `http://localhost:11434` | Host / base URL |
| `--embeddings-max-input-chars <n>` | `1024` | Truncate embedding inputs (safe for 512-token models; raise for cloud) |

### Processing & retrieval

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--chunking <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `-c, --chunk-size <n>` | `2000` | Max chunk size (chars) |
| `--overlap-size <n>` | `100` | Chunk overlap |
| `--retrieval <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `--retrieval-limit <n>` | `3` | Retrieved context entities per chunk |
| `--retrieval-scope <mode>` | `chunk` | `chunk` (per-chunk) or `file` (once, reused) |
| `--json-strategy <mode>` | `structural` | `structural` (split on JSON structure) or `raw` |

### Media & classification

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--asr <mode>` | `enabled` | `enabled\|disabled\|auto` |
| `--whisper-model <name>` | `medium` | `tiny\|base\|small\|medium\|large` |
| `--language <lang>` | `auto` | Language code or `auto` |
| `--translate` | `false` | Translate audio to English |
| `--images <mode>` | `auto` | `enabled\|disabled\|auto` (vision model required) |
| `--docling` | `false` | Docling for advanced PDF/Office parsing |
| `--classifier <mode>` | `disabled` | `disabled\|heuristic\|llm` — drives domain prompt hints and scopes `entityType` to a per-domain enum *(experimental)* |

### Merging, grounding, corpus glossary

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--entity-similarity-threshold <n>` | `0.9` | Jaro-Winkler entity dedup (0–1) |
| `--observation-similarity-threshold <n>` | `0.9` | Embedding similarity (0–1) |
| `--enable-similarity-merging` | `true` | Enable entity deduplication |
| `--grounding <mode>` | `disabled` | `disabled` · `flag` (annotate `grounded`/`groundingScore`) · `drop` (remove below threshold) |
| `--grounding-min-score <n>` | `0.5` | Min grounding score; also gates which facts the `lora` export keeps |
| `--corpus-profiling <mode>` | `disabled` | Pre-pass that builds an authoritative corpus glossary (closed vocab under v5) *(experimental)* |
| `--prompt-version <version>` | `v5` | `v5` (closed-vocab + topology hygiene) or `v4.5` (legacy) |

### Export, resume, logging

| Option | Default | Description |
| ------ | ------- | ----------- |
| `--export-format <format>` | `json` | `json\|jsonl\|mcp-jsonl\|dot\|kblam\|lora\|graphiti` |
| `--export-only` | `false` | Convert an existing graph (`--input`) to `--export-format` — no extraction |
| `--resume` | `false` | Checkpoint chunks; skip done ones on re-run |
| `--checkpoint <path>` | `<output>.checkpoint.jsonl` | Checkpoint sidecar |
| `-L, --log-level <level>` | `info` | `debug\|info\|warning\|error` |
| `-l, --log-file <path>` | — | Write logs to file |
| `-w, --watch` | `false` | Watch mode |

> Document-outline injection (`readers.outline`) and DOT styling (`export.dot`) are config-only (no CLI flags) — see the config schema.

## Output formats

### JSON (`json`)

Observations are **objects**, not bare strings — each carries provenance and the bi-temporal axis. The LLM emits plain text; `wanshi` stamps the metadata deterministically from what it knows about the chunk. Unknown fields are omitted; legacy string-observation graphs still load.

```json
{
  "entities": [
    {
      "name": "knowledge_graph_builder",
      "entityType": "class",
      "observations": [
        {
          "text": "Extracts entities and relations from file content using an LLM",
          "source": "src/core/knowledge/KnowledgeGraphBuilder.ts",
          "createdAt": "2026-06-05T15:57:59.856Z"
        }
      ],
      "files": ["src/core/knowledge/KnowledgeGraphBuilder.ts"]
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
    { "from": "knowledge_graph_builder", "to": "ollama_service", "relationType": ["uses", "depends_on"] }
  ]
}
```

### MCP-compatible JSONL (`mcp-jsonl`)

```jsonl
{"type":"entity","name":"knowledge_graph_builder","entityType":"class","observations":["Extracts entities and relations from file content using an LLM"]}
{"type":"relation","from":"knowledge_graph_builder","to":"ollama_service","relationType":"uses,depends_on"}
```

### GraphViz DOT (`dot`)

Styled, colored graph (one node per entity, colored edges per relation type, legend, config summary). Render with `dot -Tsvg graph.dot -o graph.svg` (or `neato`/`fdp`/`sfdp`/`circo`/`twopi`). Styling is config-only under `export.dot:` — layout, `rankdir`, `colorScheme` (`default\|scientific\|code\|minimal`), clustering by type or file, etc.

### KBLaM triples (`kblam`)

JSONL in the shape Microsoft [KBLaM](https://github.com/microsoft/KBLaM)'s `dataset_generation` ingests — **one `(entity, property, value)` per line**, each with the derived `Q`/`A`/`key_string` it encodes into a knowledge token. Property names are distinct per entity (relations contribute their predicate as the property), and keys are unique per `(name, property)` so rectangular-attention lookup is unambiguous.

```jsonl
{"name":"Recursion","property":"definition","value":"a function that calls itself","Q":"What is the definition of Recursion?","A":"The definition of Recursion is a function that calls itself.","key_string":"the definition of Recursion"}
{"name":"Recursion","property":"terminates_at","value":"BaseCase","Q":"What is the terminates_at of Recursion?","A":"The terminates_at of Recursion is BaseCase.","key_string":"the terminates_at of Recursion"}
```

### LoRA / SFT (`lora`)

Chat-format instruction examples derived from the same triples, **quality-filtered**: observations whose grounding score is below `--grounding-min-score` are dropped, so only grounded facts become training data.

```jsonl
{"messages":[{"role":"user","content":"What is the definition of Recursion?"},{"role":"assistant","content":"The definition of Recursion is a function that calls itself."}]}
```

### Graphiti (`graphiti`)

`add_triplet`-shaped `{ nodes, edges }` for ingestion into a [Graphiti](https://github.com/getzep/graphiti) temporal graph — entities → nodes (summary from observations), relations → `UPPER_SNAKE` edges with stable uuids. Per-fact valid-time rides along in the `json`/`kblam` exports.

## Local model guidance

Quality/speed trade-off for local selection. For measured numbers see the benchmark below.

| Model | Params | Quality | Speed | Notes |
| ----- | ------ | ------- | ----- | ----- |
| `qwen3:8b` | 8B | ★★★★★ | slower | highest extraction quality |
| `gemma3:4b` | 4B | ★★★★ | medium | best quality/speed balance |
| `qwen2.5-coder:1.5b` | 1.5B | ★★★ | fast | strong on source code |
| `qwen3:1.7b` | 1.7B | ★★★ | fast | good general purpose |
| `gemma3:1b` | 1B | ★★ | very fast | minimal resources |

Default embeddings: `mxbai-embed-large:335m`.

### Measured benchmark (CrossRE)

Dataset **CrossRE `ai-test`**, n = 17–20 (failed extractions excluded, not zeroed); prompt **v5**; generation via **OpenRouter**; matching via local `mxbai-embed-large:335m` at semantic threshold 0.80. *Indicative, not definitive — small n, single domain, cloud inference.* Reproduce with `npm run benchmark -- --provider openai --host https://openrouter.ai/api/v1 --model <id> --dataset crossre --limit 20 --prompt-version v5`.

| Model | n | Entity F1 (sem) | Relation F1 | Triple F1 | Intrinsic |
| ----- | - | --------------- | ----------- | --------- | --------- |
| `qwen3-14b` | 17 | **0.851** | 0.130 | 0.037 | 83.9 |
| `qwen3-8b` | 19 | 0.808 | 0.187 | 0.019 | 82.0 |
| `gemma-3-4b-it` | 20 | 0.807 | 0.198 | 0.036 | 83.4 |
| `gemma-3-27b-it` | 20 | 0.767 | **0.211** | **0.070** | 82.8 |
| `gemma-3-12b-it` | 20 | 0.716 | 0.093 | 0.019 | 74.7 |

The **"small Gemma beats larger Gemmas"** result holds under corrected sampling: `gemma-3-4b-it` outperforms both `gemma-3-12b-it` and `-27b-it` on entity extraction and lands ~2nd of 5 overall. Relation/triple F1 are uniformly low — CrossRE relation extraction is hard under strict matching.

## Quality metrics

Importable evaluators in `src/quality/` (also wired into `npm run benchmark`): **structural** (counts, density, type distribution), **semantic** (name quality, observation specificity, coverage), **factual** (grounding, hallucination, contradiction — this one also backs the inline grounding gate), and **consistency** (cross-file naming, type coherence), rolled into a 0–100 composite that can gate which graphs are harvested for `kblam`/`lora` training data.

## Architecture

```text
src/
├── cli/          # Commander.js CLI (process/watch/export; --export-only)
├── core/
│   ├── di/        # Async DI container + service registrations
│   ├── processor/ # File readers (transcript, JSON, PDF, Office, audio, …) + chunking + classifiers
│   ├── checkpoint/# Per-chunk resume sidecar
│   ├── llm/       # Ollama / OpenAI-compatible providers, embeddings, Handlebars prompts
│   ├── knowledge/ # KG building (LLM+Zod, provenance + grounding gate), 3-level merge, vector search
│   └── export/    # Strategy pattern: json, jsonl, mcp-jsonl, dot, kblam, lora, graphiti
├── quality/      # Importable metrics (structural, semantic, factual, consistency, composite)
├── evaluation/   # Benchmark harness (CrossRE / REBEL / RE-DocRED)
├── types/        # Interfaces and data models
└── shared/       # Logger, graceful shutdown, utilities (Jaro-Winkler, cosine, config)
```

Tests use Jest (`npm test`); mock the LLM via `ILLMProvider` for network-free unit tests.

## Development

```bash
git clone https://github.com/AlexSabaka/wanshi && cd wanshi && npm install
npx ts-node ./src/index.ts --config config.yaml   # run directly
npm run build && node ./dist/index.js --config config.yaml   # or build first
```

See `examples/kg-mail-assistant/` for a full integration (Gmail OAuth + Telegram bot + continuous email→KG pipeline) and programmatic usage via `ContainerFactory`.

## Acknowledgments

- **[Ollama](https://ollama.ai)** — local LLM runtime and embeddings
- **[LangChain](https://github.com/langchain-ai/langchainjs)** — text-splitting utilities
- **[OpenAI Whisper](https://github.com/openai/whisper)** (via `nodejs-whisper`) — audio transcription
- **Anthropic** — the MCP protocol, and Claude as a build partner (Cheetah 🐆 on the code, Dove 🕊️ on the audits)
- **[KBLaM](https://github.com/microsoft/KBLaM)** and **[Graphiti](https://github.com/getzep/graphiti)** — prior work this project's training exports and temporal model lean on

## License

MIT — see [LICENSE](LICENSE).

---

*Knows ten thousand things; keeps only the ones it can source.*
