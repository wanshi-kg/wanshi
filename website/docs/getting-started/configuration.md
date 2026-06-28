---
id: configuration
title: Configuration
description: The nested config-file shape, plus the cloud-generation + resume setup.
---

# Configuration

The config file uses a **nested** shape (the source of truth is the Zod schema in `src/config/`); CLI flags stay flat. Run `wanshi schema` to print the full JSON Schema — or read the generated **[configuration reference](../reference/configuration.md)** for every key, type, and default.

:::tip Just want a config to copy?
See **[Configuration tiers](../guides/config-tiers.md)** for four ready-made presets — Fast/Low → Balanced/Med → High-quality → Max-features — each validated against the schema.
:::

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
  model: nomic-embed-text
  host: http://localhost:11434

chunking: { mode: enabled, size: 4000, overlap: 100 }
retrieval: { mode: enabled, limit: 3 }

merging:
  enableSimilarityMerging: true
  entitySimilarityThreshold: 0.9
  observationSimilarityThreshold: 0.7

export: { format: jsonl }
```

Upgrading from an older flat config? See the **[config migration guide](../guides/migration.md)**.

## Cloud generation + resume

Point generation at any OpenAI-compatible endpoint (`provider: openai`, `host` = base URL), keep embeddings local so dedup/merge stays free, and enable `resume` so an interrupted run continues without reprocessing.

```yaml
llm:
  provider: openai
  host: https://openrouter.ai/api/v1
  apiKey: sk-or-...          # or $OPENAI_API_KEY / $WANSHI_API_KEY
  model: google/gemma-3-27b-it
embeddings:
  provider: ollama
  model: nomic-embed-text
resume:
  enabled: true             # writes <output>.checkpoint.jsonl
```

If the run dies mid-way, just run the same command again — finished chunks are skipped. **Ctrl+C once** finishes the in-flight chunk, checkpoints it, and writes the partial graph before exiting; press again to force-quit.

A chunk is reused only when its **file content, chunk size/overlap, model, and prompt version** all match — these are folded into the checkpoint key. Files are keyed by path *relative to `--input`*, so relocating the whole tree keeps checkpoints valid; only editing a file re-runs it.
