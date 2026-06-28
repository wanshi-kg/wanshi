---
id: config-tiers
title: Configuration tiers
description: Four copy-paste config presets — Fast/Low, Balanced/Med, High-quality, Max-features — grounded in the real schema.
---

# Configuration tiers

Four ready-to-paste presets, from a speed floor to an everything-on production pipeline. Each is **valid against the current config schema** (`wanshi schema`); copy one to `config.yaml` and run `wanshi --config config.yaml`. The full field-by-field reference is on the **[Configuration reference](../reference/configuration.md)** page.

| Tier | Use when | Model | Grounding | Notable extras | Cost |
| --- | --- | --- | --- | --- | --- |
| **Fast / Low** | quick preview, dev iteration, low-RAM box | `gemma3:1b` | off | retrieval off, looser merge | free |
| **Balanced / Med** *(default)* | most projects | `gemma3:4b` | `flag` | retrieval on (the recommended baseline) | free |
| **High-quality** | accuracy matters, research | `qwen3:8b` | `drop` | corpus glossary (closed vocab) + AST seeding | free (local) |
| **Max-features** | production, mixed media + references | cloud gen + local embeddings | `drop` (MiniCheck) | references/citations, EXIF/C2PA/object-detection, SQLite, cost cap, trace | ~$/run |

> Embeddings stay on local Ollama in every tier (even Max-features) — dedup/merge is free, and only generation is metered when you go cloud.

## Fast / Low

**Use when:** you want a quick first graph, you're iterating, or you're on a small machine. Smallest model, aggressive chunking, no retrieval or grounding — the speed floor.

```yaml
llm:
  provider: ollama
  model: gemma3:1b
  temperature: 0.1
embeddings:
  provider: ollama
  model: nomic-embed-text
chunking:
  mode: enabled
  size: 1500
  overlap: 50
retrieval:
  mode: disabled
merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.85
  observationSimilarityThreshold: 0.85
grounding:
  mode: disabled
export:
  format: json
```

## Balanced / Med  *(recommended default)*

**Use when:** the everyday choice for most projects. The 4B model is the best quality/speed balance; retrieval is on for cross-chunk context, and the grounding gate is set to `flag` (annotate ungrounded facts without dropping them).

```yaml
llm:
  provider: ollama
  model: gemma3:4b
  contextLength: 12000
  temperature: 0.1
embeddings:
  provider: ollama
  model: nomic-embed-text
chunking:
  mode: enabled
  size: 2000
  overlap: 100
retrieval:
  mode: enabled
  limit: 3
merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.9
  observationSimilarityThreshold: 0.9
grounding:
  mode: flag
  minScore: 0.5
  checker: keyword
export:
  format: json
```

## High-quality

**Use when:** accuracy matters more than speed — research, a graph you'll query a lot. Larger model, lower temperature, stricter merge, grounding set to `drop` (ungrounded facts are removed), plus the corpus glossary (a closed entity/relation vocabulary) and AST seeding for code.

```yaml
llm:
  provider: ollama
  model: qwen3:8b
  contextLength: 16000
  temperature: 0.05
embeddings:
  provider: ollama
  model: nomic-embed-text
  maxInputChars: 2048
chunking:
  mode: enabled
  size: 3000
  overlap: 200
retrieval:
  mode: enabled
  limit: 5
merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.92
  observationSimilarityThreshold: 0.92
grounding:
  mode: drop
  minScore: 0.6
  checker: keyword
corpus:
  profiling: enabled
  topTerms: 150
ast:
  mode: enabled
export:
  format: json
```

## Max-features

**Use when:** a production run over a mixed corpus (docs, PDFs, images, databases) where you want every meaningful signal: cloud generation for capability (embeddings stay local & free), MiniCheck grounding, references + citation fetching, image enrichment (EXIF/C2PA/object-detection), the SQLite adapter, a spend cap, and a debug trace. All of these are **opt-in** — a default run touches none of them.

```yaml
input: ./corpus
filter: ["**/*"]
exclude: ["**/node_modules/**", "**/.git/**"]
output: knowledge-graph.json
description: "Production knowledge graph — all pipelines on"
llm:
  provider: openai
  host: https://openrouter.ai/api/v1
  model: deepseek/deepseek-v4-pro
  apiKey: $OPENAI_API_KEY
  contextLength: 16000
  temperature: 0.05
  maxTokens: 4000
embeddings:
  provider: ollama          # keep dedup/merge local & free
  model: nomic-embed-text
chunking:
  mode: enabled
  size: 3000
  overlap: 200
retrieval:
  mode: enabled
  limit: 5
  scope: chunk
merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.92
  observationSimilarityThreshold: 0.92
  supersession: heuristic
grounding:
  mode: drop
  minScore: 0.6
  checker: minicheck
  model: bespoke-minicheck:7b
  escalateAbove: 0.8
corpus:
  profiling: enabled
  topTerms: 200
ast:
  mode: enabled
readers:
  pdfEngine: marker
  stripReferences: true
  images: enabled
  exif:
    enabled: true
  c2pa:
    enabled: true
  cv:
    detection:
      enabled: true
      mode: closed
      threshold: 0.5
references:
  internalLinks:
    enabled: true
  citations:
    enabled: true
    fetch:
      enabled: true
      allowlist: ["arxiv.org", "ncbi.nlm.nih.gov"]
      maxFetches: 100
    titleResolver:
      enabled: true
  follow:
    enabled: true
    maxDepth: 2
    maxFiles: 5000
adapters:
  sqlite:
    enabled: true
    maxRowsPerTable: 10000
export:
  format: json
resume:
  enabled: true
trace:
  enabled: true
cost:
  enabled: true
  maxCost: 50.0
  currency: USD
```

---

Picking a model for a tier? See **[Local model guidance](./local-models.md)** and the measured **[benchmarks](../benchmarks/results.md)**. Every field above (and many more) is documented on the **[Configuration reference](../reference/configuration.md)**.
