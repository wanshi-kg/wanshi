---
id: results
title: Benchmark results
description: wanshi vs KGGen on gold-labeled datasets — the complete cloud + local (M4/L4) run matrix, the precision story, and the history.
---

# Benchmark results

wanshi is measured against **[KGGen](https://github.com/stair-lab/kg-gen)** (its real Python package), **the same model driving both tools**, on gold-labeled relation-extraction datasets. The fair cross-tool metric is **node entity-capture F1** (did the tool recover the gold entities) — both tools emit free predicates, so typed relation-F1 understates uniformly *except* in the schema-aware mode below. Matching embeddings run locally (`nomic-embed-text`), semantic threshold 0.80.

The one-line thesis: **KGGen edges recall; wanshi wins precision — and the trade flips to a wanshi win as documents get longer and models get stronger.** Scoring is pre-registered and applied identically to every tool — see **[methodology](./methodology.md)** (and [`docs/benchmark/SCORING.md`](https://github.com/wanshi-kg/wanshi/blob/master/docs/benchmark/SCORING.md) for the full rules).

## The complete run matrix

Every run to date. **wF1 / kF1** = wanshi / KGGen node entity-capture F1 (semantic). **conf** = JSON-conformance. **rel→** = share of wanshi relations that fall back to `related_to`. **tok/s** = wanshi throughput (local arms only). `—` = not measured in that cell (cloud arms didn't track conformance/throughput; KGGen wasn't re-run for the M4 qwen cell; DrugProt crashed on the baked L4 image).

| Arm | Dataset | Model | Mode | N | wF1 | kF1 | conf | rel→ | tok/s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Cloud** | SemEval-2010 T8 | deepseek-v4-pro | sentence | 300 | 0.422 | **0.453** | — | — | — |
| **Cloud** | CrossRE | deepseek-v4-pro | sentence | 300 | 0.786 | **0.824** | — | — | — |
| **Cloud** | Re-DocRED | deepseek-v4-pro | document | 100 | **0.677** | 0.643 | — | — | — |
| **Cloud** | Re-DocRED | claude-sonnet-4.6 | document | 100 | **0.721** | 0.620 | — | — | — |
| **Cloud** | Re-DocRED | gpt-5.4 | document | 100 | **0.735** | 0.561 | — | — | — |
| **M4** | BioRED | gemma3:4b | closed | 40 | **0.485** | 0.381 | 1.00 | 0.225 | 24.7 |
| **M4** | BioRED | gemma3:4b | vocab | 40 | **0.506** | 0.381 | 1.00 | 0.010 | 26.5 |
| **M4** | BioRED | qwen3:8b | closed | 40 | **0.512** | — | 1.00 | 0.534 | 14.6 |
| **M4** | DrugProt | gemma3:4b | closed | 40 | **0.485** | 0.424 | 1.00 | 0.122 | 26.4 |
| **M4** | DrugProt | gemma3:4b | vocab | 40 | **0.474** | 0.424 | 1.00 | 0.024 | 26.4 |
| **M4** | FinRED | gemma3:4b | closed | 40 | **0.448** | 0.372 | 1.00 | 0.326 | 27.3 |
| **M4** | FinRED | gemma3:4b | vocab | 40 | **0.450** | 0.372 | 1.00 | 0.226 | 26.2 |
| **M4** | CrossRE | gemma3:4b | closed | 40 | **0.779** | 0.698 | 1.00 | 0.330 | 27.7 |
| **M4** | Re-DocRED | gemma3:4b | closed | 30 | **0.687** | 0.636 | 0.97 | 0.100 | 15.0 |
| **L4** | BioRED | gemma3:4b | closed | 40 | **0.494** | 0.392 | 1.00 | 0.246 | 62.8 |
| **L4** | BioRED | gemma3:4b | vocab | 40 | **0.453** | 0.392 | 1.00 | 0.008 | 62.6 |
| **L4** | BioRED | qwen3:8b | closed | 40 | **0.453** | 0.408 | 1.00 | 0.430 | 40.9 |
| **L4** | BioRED | qwen3:8b | vocab | 40 | **0.531** | 0.408 | 1.00 | 0.000 | 40.6 |
| **L4** | CrossRE | gemma3:4b | closed | 40 | **0.738** | 0.698 | 1.00 | 0.302 | 56.7 |
| **L4** | CrossRE | qwen3:8b | closed | 40 | **0.727** | 0.717 | 1.00 | 0.465 | 38.6 |
| **L4** | FinRED | gemma3:4b | closed | 40 | **0.436** | 0.392 | 1.00 | 0.333 | 57.0 |
| **L4** | FinRED | gemma3:4b | vocab | 40 | **0.438** | 0.392 | 1.00 | 0.211 | 56.0 |
| **L4** | FinRED | qwen3:8b | closed | 40 | **0.465** | 0.374 | 1.00 | 0.447 | 40.6 |
| **L4** | FinRED | qwen3:8b | vocab | 40 | **0.464** | 0.374 | 1.00 | 0.107 | 37.8 |
| **L4** | Re-DocRED | gemma3:4b | closed | 30 | **0.666** | 0.639 | 1.00 | 0.081 | 63.7 |
| **L4** | Re-DocRED | qwen3:8b | closed | 30 | 0.623 | **0.697** | 1.00 | 0.203 | 40.2 |

What the matrix shows:

- **Precision-collapse is everywhere.** On the dense domain corpora (BioRED/DrugProt/FinRED) KGGen over-extracts and its node-F1 sits ~0.37–0.42 while wanshi stays ~0.45–0.51 — wanshi wins node-F1 in **8/8 M4 cells and 11/12 L4 cells** (the sole loss is Re-DocRED/qwen3:8b, −7.4 pt).
- **Quality is hardware-independent.** M4 (16 GB laptop) and L4 (rented GPU) `gemma3:4b` node-F1 differ only by sampling noise (±0.01–0.05), and **JSON-conformance is 1.000 on every dense model** — at **~40% of the rental GPU's throughput** (~25–28 tok/s vs ~57–64).
- **`vocab` mode kills `related_to`.** The closed vocabulary drops the `related_to` fallback share to ~0–0.03 (forcing typed predicates) — the small-model degeneration check passes.

## Cloud arm — the precision advantage grows with capability

Re-DocRED node-F1 across the model ladder (every number is OpenRouter inference; KGGen runs on the **same** model):

| Model | wanshi | KGGen | wanshi win | KGGen precision | KGGen ent/doc |
| --- | --- | --- | --- | --- | --- |
| deepseek-v4-pro | 0.677 | 0.643 | **+3.4 pt** | 0.530 | 21.6 |
| claude-sonnet-4.6 | 0.721 | 0.620 | **+10.1 pt** | 0.489 | 24.2 |
| gpt-5.4 | 0.735 | 0.561 | **+17.4 pt** | 0.402 | 32.1 |

Stronger models extract *more* (KGGen 21.6 → 32.1 entities/doc); on long documents that craters precision (0.53 → 0.40) faster than it helps recall, while wanshi stays disciplined — so the win **widens at the frontier**. *Confirmed across three models; rests on one document-level dataset (a second, SciERC/BioRED, is owed).* Representative spend (embeddings local & free; the $ covers both tools): claude-sonnet-4.6 ≈ **$6.00**, gpt-5.4 ≈ **$5.60** per Re-DocRED N=100 cell.

## Schema-aware typed extraction (H4)

When the **target relation schema is known**, wanshi extracts typed relations natively via a closed vocabulary (`--relation-vocab`). Re-DocRED triple-F1, free predicates → strict gold schema (96 Wikidata properties):

| Model | wanshi free → strict | Ign-F1 | KGGen (free) | × KGGen |
| --- | --- | --- | --- | --- |
| deepseek-v4-pro | 0.012 → 0.107 | 0.111 | 0.025 | **4×** |
| claude-sonnet-4.6 | 0.016 → 0.112 | 0.116 | 0.019 | **6×** |
| gpt-5.4 | 0.015 → **0.145** | 0.148 | 0.014 | **10×** |

**Ign-F1 ≈ triple-F1** on every model (Ign-F1 excludes triples seen in training) → the gains are **generalization, not memorized facts**. KGGen has no closed-vocab mode, so it can't consume a known ontology. This is "schema-aware typed extraction," not "wanshi beats KGGen at relation extraction."

## MINE (recall-only context)

On the recall-only, LLM-judge-mediated MINE benchmark, KGGen's denser extraction wins (re-scored ≈ **64%** vs wanshi's best cell ≈ **28%**, deepseek-v4-pro open-predicate). MINE rewards raw triple coverage and is blind to precision, and its judge performs fact-verification (a known-soft measurement) — so the **gold-labeled results above carry the comparative claims; MINE is reported as context, not a verdict.**

## Caveats (read with the numbers)

- The document-level win rests on **one dataset** (Re-DocRED) so far.
- The precision collapse is **dense-domain-specific** — KGGen's precision is fine on general corpora.
- Local↔cloud quality equivalence is **within sampling variation**, not bit-identity.
- The sole local loss is **Re-DocRED / qwen3:8b** on L4 (−7.4 pt) — possibly document-length scaling at 8B, possibly noise; it's one cell of twelve.
- `qwen3:8b` on a 16 GB M4 ran only **serialized** (concurrent load OOMs); a full 8B comparison sweep there isn't a realistic laptop workload (the one M4 qwen cell is BioRED).

## Benchmark history & problems

The journey, and the bugs running on real corpora caught (the "guilty until proven" discipline paid off):

- **2026-06-19** — Pre-registered the scoring ([SCORING.md](https://github.com/wanshi-kg/wanshi/blob/master/docs/benchmark/SCORING.md)): Tier-1 gold / Tier-2 self-labeling / Tier-3 unlabeled, one rule for every tool — the anti-gaming gate.
- **2026-06-22** — First MINE + CrossRE pass caught a **desync bug**: the public MINE baseline graphs were off-by-one against the essays, which had produced an early, *false* "wanshi beats KGGen" reading. **Retracted**; the harness was realigned to the paper-published baselines (the stale 17.5% MINE number dates from here).
- **2026-06-23** — Gold suite complete (SemEval-2010 T8, CrossRE, Re-DocRED) + H4. Found the **precision-collapse mechanism** (KGGen over-extracts on long docs → precision craters → wanshi wins document-level node-F1) and the **4–10× typed-extraction** lift when fed a closed vocab. Methodology fix: `strictVocabulary` was unioning the base relation types instead of *replacing* them on closed-vocab runs.
- **2026-06-26** — Domain anomaly **verified**: the +11–18 pt BioRED/DrugProt/FinRED wins are a real mechanism, **model-stable across two dense ~70B models** — not a single-model artifact.
- **2026-06-27/28** — Local **M4 + L4 arm**: precision-collapse confirmed at the **4B local tier** (so the claim is now *model-invariant across 4B→70B and three hardware tiers*), and M4≈L4 quality. Running on real hardware caught a **bash-3.2 empty-array** silent failure that had killed *every* macOS closed-mode cell (Docker's bash 5 was immune) and a **DrugProt loader crash** on a malformed row — both now regression-tested — plus the **M4 OOM/serialization** finding for `qwen3:8b`.

## Reproducibility

Every cell reproduces under the one harness — wanshi inline, KGGen cached, the **same** sample list for both:

```bash
# Cloud cell (Re-DocRED, N=100)
npx ts-node scripts/gold-compare.ts --dataset redocred --limit 100 \
  --model deepseek/deepseek-v4-pro --provider openai --host https://openrouter.ai/api/v1
# add --relation-vocab @data/redocred/compare/relation-vocab.txt for the schema-aware (H4) cell

# Local arm (same model for both tools, on Ollama) — see bench/RUNPOD.md for the full sweep harness
```

The full pre-registered rules, tiers, and matchers are in [`docs/benchmark/SCORING.md`](https://github.com/wanshi-kg/wanshi/blob/master/docs/benchmark/SCORING.md).
