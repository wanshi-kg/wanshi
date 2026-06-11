# Follow-up brief: embeddinggemma-native canonicalization

**From:** Cheetah · **To:** Dove · **Date:** 2026-06-10

## Why this exists

NR-1..NR-4 ran with the telegram-sink corpus migrated to **embeddinggemma-300m**
(Sabaka's config change) for generation + embeddings. NR-3 surfaced that the canon
hybrid arm, tuned on **mxbai-embed-large** last round, does **not** transfer to
embeddinggemma. NR-3 was shipped on mxbai (config-only: `config-canon.yaml`
`embeddings.model: mxbai-embed-large:335m` for the canon arm). Making canon work
*natively* on embeddinggemma is deferred here so it's a properly scoped task, not a
mid-round detour.

## Evidence (embeddinggemma @ entity threshold 0.88, hybrid, escalateBand [0.72,0.88])

Clean post-NR-1 corpus (625 entities). Canon collapsed to 493 but **over-merged**:

- **Sibling fusion (controlled-comparison killer):** one 8-member cluster, min
  intra-sim 0.699, fused the three *distinct* Epicure ablation models +
  the parent: `Epicure | Cooc | Chem | Core | Cooc graph | Epicure-Cooc |
  Epicure-Core | Epicure-Chem` → `Chem`. The `Epicure-*` prefix variants bridge the
  bare siblings and **single-linkage** chains the whole family. Digit-veto can't help
  (no digits); entityType-veto can't help (all same type).
- **Cross-domain merges:** `NPU | NPMI | NMI | Normalised mutual information`
  (hardware ⊍ statistics); `Apple | Apple Silicon | iPhone | Mac | MacBook Air`;
  `East Asian | Southeast Asian | South Asian`.
- **Cost/latency blowup:** the loose geometry put a huge fraction of pairs in the
  escalation band → **26,565 LLM adjudication calls, ~4h20m wall-clock**. Impractical
  for the live bot (every sink rebuild).

Root cause: embeddinggemma cosine of 0.88 ≈ "loosely related," not the
"near-identical" it meant on mxbai. The threshold + band were calibrated for the
wrong distribution.

## Proposed scope (when picked up)

1. **Complete-linkage clustering** (the decisive fix for sibling chaining): require
   *all* pairs in a cluster ≥ threshold, not mere connectivity. Add as an option to
   `agglomerativeClusters` / `clusterByEmbedding` in
   `src/shared/utils/agglomerativeCluster.ts` (the `decide` hook is already
   pair-aware after NR-3-round-1). This alone breaks the 8-member chain because
   `Cooc`↔`Chem` are not directly similar enough.
2. **Re-tune the embeddinggemma threshold** against a fresh merge log — expect
   meaningfully higher than 0.88 (probe 0.92–0.95). Tune against the log, never type
   counts (canon brief §5).
3. **Tame the escalation band** so adjudication stays in the hundreds, not tens of
   thousands — narrow the band and/or gate escalation behind complete-linkage
   candidacy.
4. Optional but clean: a `pipeline.canonicalization.embeddingModel` override so canon
   can cluster on one model while generation/merge-dedup use another (this round used
   a whole-arm `embeddings.model` swap, which also changed merge-dedup — a minor A/B
   impurity).

## Verification target

On the clean corpus: Cooc/Core/Chem **stay three distinct entities**; their `X model`
variants fold into them; no cross-domain clusters; adjudication call count in the low
hundreds; wall-clock in minutes.

## Out of scope (unchanged)

Prompt/template changes; extraction-order inversion; DoclingReader references parity;
`FileProcessor.processFiles` bug.
