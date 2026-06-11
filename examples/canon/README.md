# Canonicalization experiment (Experiment 1)

Tests whether kg-gen's entity-/relation-type **sprawl** comes from *extraction
order* or from the **absence of a global merge pass** — by bolting a global
canonicalization stage onto the existing schema-first pipeline and measuring.
Spec: [`docs/inbox/kg-gen-canon-brief.md`](../../docs/inbox/kg-gen-canon-brief.md).

## Arms

| Arm | config | canonicalization |
| --- | --- | --- |
| `baseline` | [`baseline.yaml`](baseline.yaml) | disabled (current pipeline, fresh numbers) |
| `canon_embed` | [`canon_embed.yaml`](canon_embed.yaml) | embeddings clustering |
| `canon_hybrid` *(optional)* | [`canon_hybrid.yaml`](canon_hybrid.yaml) | embeddings + LLM adjudication of borderline pairs |

All three are pinned identical (corpus, seed `1337`, model, embedding model) so
the A/B isolates the canonicalization variable. Only the
`pipeline.canonicalization` block differs. Outputs land in `kg_tests/canon/`
(gitignored).

## Run + score

```bash
# 1. Produce each arm's graph (local Ollama, or uncomment the OpenRouter llm block)
kg-gen --config examples/canon/baseline.yaml
kg-gen --config examples/canon/canon_embed.yaml

# 2. Score every arm with the same scorecard
kg-gen metrics kg_tests/canon/baseline.json
kg-gen metrics kg_tests/canon/canon_embed.json
#   add --ground-truth observations_87.jsonl for ER precision/recall + fabricated-edge rate

# 3. Audit the merge decisions — the deliverable, not the graph
kg-gen inspect-merges kg_tests/canon/canon_embed.merges.jsonl
```

`kg-gen metrics` reports the no-ground-truth scorecard (entity/relation-type
counts, self-loops, bidirectional contradictions, referential integrity,
parallel edges). `kg-gen inspect-merges` lists every collapsed cluster,
**suspicious over-merges first** (low intra-cluster similarity) — e.g. distinct
model sizes fused, or a format collapsed with its parse functions.

## The one rule

**Do not tune `threshold` to minimize the type-count number** (brief §5) — that
directly incentivizes over-merge, which is invisible in the aggregate counts and
only visible in the merge log. Tune against `inspect-merges`.
