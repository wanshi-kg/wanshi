# Config migration — flat → nested

wanshi's configuration moved from a flat ~50-key bag to a **nested, grouped, and
validated** shape, with a single source of truth (the Zod `ConfigSchema` in
`src/config/schema.ts`). This is a **clean break**: a flat config file now errors
with a hint naming the new nested key. CLI flags are **unchanged** (they stay
flat and ergonomic, e.g. `--chunk-size`); only **config files** (`--config
*.yaml|*.json`) use the nested shape.

The schema is also the thing the frontend reads (`wanshi schema`), so the form no
longer duplicates the field list.

## Why

- One source of truth: the TS type (`ProcessingOptions`), runtime validation +
  defaults, and the frontend's JSON Schema all derive from one Zod schema.
- Defaults live in the schema only (CLI flags carry none), so precedence is a
  clean **defaults < config file < CLI flags < env**.
- Unknown/legacy keys fail fast with a migration hint instead of silently
  miscasting.

## Top-level keys (unchanged)

`input`, `filter`, `exclude`, `output`, `description` stay at the top level.

## Flat → nested mapping

| Old flat key | New nested key |
| --- | --- |
| `provider` | `llm.provider` |
| `model` | `llm.model` |
| `host` | `llm.host` |
| `apiKey` | `llm.apiKey` |
| `temperature` | `llm.temperature` |
| `repeatPenalty` | `llm.repeatPenalty` |
| `contextLength` | `llm.contextLength` |
| `maxTokens` | `llm.maxTokens` |
| `seed` | `llm.seed` |
| `system` | `llm.system` |
| `promptVersion` | `llm.promptVersion` |
| `embeddingsProvider` | `embeddings.provider` |
| `embeddingsModel` | `embeddings.model` |
| `embeddingsHost` | `embeddings.host` |
| `embeddingsApiKey` | `embeddings.apiKey` |
| `embeddingsMaxInputChars` | `embeddings.maxInputChars` |
| `chunking` | `chunking.mode` |
| `chunkSize` | `chunking.size` |
| `overlapSize` | `chunking.overlap` |
| `retrieval` | `retrieval.mode` |
| `retrievalLimit` | `retrieval.limit` |
| `retrievalScope` | `retrieval.scope` |
| `entitySimilarityThreshold` | `merging.entitySimilarityThreshold` |
| `observationSimilarityThreshold` | `merging.observationSimilarityThreshold` |
| `enableSimilarityMerging` | `merging.enableSimilarityMerging` |
| `grounding` | `grounding.mode` |
| `groundingMinScore` | `grounding.minScore` |
| `corpusProfiling` | `corpus.profiling` |
| `corpusTopTerms` | `corpus.topTerms` |
| `corpusProfilePath` | `corpus.profilePath` |
| `corpusClustering` | `corpus.clustering` |
| `classifier` | `classifier.mode` |
| `docling` | `readers.pdfEngine: docling` (the PDF slot is now an engine enum: `pdf2json\|docling\|marker\|mistral`) |
| `images` | `readers.images` |
| `jsonStrategy` / `jsonReader` | `readers.json` (`.strategy`, `.maxChunkSize`) |
| `asr` | `readers.asr.mode` |
| `whisperModel` | `readers.asr.whisperModel` |
| `language` | `readers.asr.language` |
| `translate` | `readers.asr.translate` |
| `outline` | `readers.outline` |
| `exportFormat` | `export.format` |
| `dotOptions` | `export.dot` |
| `resume` | `resume.enabled` |
| `checkpointPath` | `resume.checkpointPath` |
| `logLevel` | `logging.level` |
| `logFile` | `logging.file` |
| `debug` | `logging.debug` |
| `silent` | `logging.silent` |
| `progressNdjson` | `logging.progressNdjson` |
| `watch` | `runtime.watch` |
| `exportOnly` | `runtime.exportOnly` |

## Example

**Before (flat):**

```yaml
input: /path/to/project
output: ./kg-output.jsonl
provider: openai
host: https://openrouter.ai/api/v1
model: google/gemma-3-27b-it
embeddingsProvider: ollama
embeddingsModel: mxbai-embed-large:335m
chunkSize: 2000
exportFormat: jsonl
resume: true
logLevel: debug
```

**After (nested):**

```yaml
input: /path/to/project
output: ./kg-output.jsonl

llm:
  provider: openai
  host: https://openrouter.ai/api/v1
  model: google/gemma-3-27b-it

embeddings:
  provider: ollama
  model: mxbai-embed-large:335m

chunking:
  size: 2000

export:
  format: jsonl

resume:
  enabled: true

logging:
  level: debug
```

## Inspecting the schema

```bash
node ./dist/index.js schema          # pretty-printed JSON Schema + UI groups
node ./dist/index.js schema --json   # compact single line
```
