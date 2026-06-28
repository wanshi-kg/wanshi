---
id: local-models
title: Local model guidance
description: Quality/speed trade-offs for picking a local Ollama model.
---

# Local model guidance

Quality/speed trade-off for local selection. For measured numbers see the **[benchmarks](../benchmarks/results.md)**.

| Model | Params | Quality | Speed | Notes |
| ----- | ------ | ------- | ----- | ----- |
| `qwen3:8b` | 8B | ★★★★★ | slower | highest extraction quality |
| `gemma3:4b` | 4B | ★★★★ | medium | best quality/speed balance |
| `qwen2.5-coder:1.5b` | 1.5B | ★★★ | fast | strong on source code |
| `qwen3:1.7b` | 1.7B | ★★★ | fast | good general purpose |
| `gemma3:1b` | 1B | ★★ | very fast | minimal resources |

Default embeddings: `nomic-embed-text`.

## Measured on real hardware

These ratings are now grounded in measured runs. On a **16 GB M4 laptop** vs a rented **L4 GPU**, `gemma3:4b` produces the **same** knowledge graph — node-F1 within ±0.01–0.05 sampling noise, JSON-conformance **1.000** — at **~40% of the GPU's throughput** (~25–28 tok/s vs ~57–64). `qwen3:8b` runs on 16 GB only **serialized** (concurrent load OOMs). See the **[complete run matrix](../benchmarks/results.md#the-complete-run-matrix)**.

For ready-to-paste configs matched to each tier, see **[Configuration tiers](./config-tiers.md)**.
