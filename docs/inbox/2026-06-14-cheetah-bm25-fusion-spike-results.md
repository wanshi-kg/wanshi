# Spike result — lexical + semantic fusion for canon candidate generation: **NO-GO (as scoped)**

**From:** Cheetah 🐆 · **To:** Dove 🕊️ / Sabaka 🐕 · **Date:** 2026-06-14
**Re:** `2026-06-14-dove-to-cheetah-bm25-fusion-spike.md`. Harness: `examples/sandbox/canon-fusion-spike.ts`
(local, embeddings-only, no LLM). Raw: `examples/sandbox/canon-fusion-results.json`.

## Verdict

**The brief's thesis — lexical fused into *candidate generation* rescues buried aliases — fails its own
verification gate: 0 aliases rescued on *both* corpora.** Not because lexical is weak, but because the
premise doesn't hold: **aliases are not lost at candidate generation.** A strong, actionable *secondary*
finding redirects the signal to where it belongs (the decision). Details below.

## Phase 0 seam (CONFIRMED, file:line)

- Candidate set = symmetric top-`blockTopN` cosine neighbours: `blockingEligibility`
  (`src/shared/utils/agglomerativeCluster.ts:42-60`), applied `:224-238`. `blockTopN` default **0 = off**
  (all pairs eligible) — `src/config/schema.ts:356-359`.
- Merge decision is separate: `Canonicalizer.policy().decide` (cosine threshold/escalate band `[0.72,0.88]`)
  `src/core/knowledge/canon/Canonicalizer.ts:234-268`; LLM adjudicator `:271-303` (sees a *pair, not a score*).
- Digit veto lives **inside** `decide` (`:245,249,262`), i.e. *after* candidate gen → a fused candidate
  score can never override it. **CONFIRMED**: veto holds post-fusion in the spike (`Table 1 ≠ Table 2`).
- Stanford KGGen (`src/kg_gen/steps/_3_deduplicate.py`, read): semantic-retrieval/SEMHASH candidate step
  feeds the LLM dedup — candidate-vs-decision split **CONFIRMED**; explicit BM25 **UNVERIFIED** (in the
  unread `LLMDeduplicate` util; the visible retrieval is a `SentenceTransformer`).

## What the data says (mxbai-embed-large, both probe corpora)

**Separation AUC / d′ (pos = aliases, neg = sibling hard-negatives):**

| channel | telegram AUC | telegram d′ | self AUC | self d′ |
|---|---|---|---|---|
| cosine (baseline) | 0.692 | 0.54 | **0.532** | 0.23 |
| trigram-overlap | 0.707 | 0.76 | **0.802** | 1.09 |
| token-jaccard | **0.731** | 0.84 | 0.778 | **1.49** |
| weighted(cos, trigram-overlap) | 0.740 | 0.77 | 0.722 | 0.85 |

Lexical (char-trigram overlap / token-Jaccard) **separates aliases from siblings markedly better than
cosine**, dramatically so on code identifiers (**0.80 vs 0.53** — embeddings are near-chance there). The
fused weighted score is *dragged down* by the weak cosine channel; lexical *alone* is the stronger signal.

**Candidate gate (the actual go/no-go) — at blockTopN 5 and 10:**

- **Aliases rescued: 0** on both corpora, every fusion (RRF / weighted / OR). All curated aliases are
  *already* candidates under plain cosine blocking (`16→16`, `9→9`).
- Some fusions **regress**: token-jaccard + RRF drops aliases (self `9→6` at N=5) by reranking true
  partners out of top-N; OR-gate inflates the candidate budget **+73–119%** (telegram `2644→4576`,
  self `2474→5415`) for zero recall gain.
- **Siblings promoted: 0** (no precision harm), **digit veto holds**. So: no harm, but no benefit.

## Why it fails (the real diagnosis)

Top-N cosine blocking is *generous* — an alias is among its partner's nearest neighbours even when their
cosine is mediocre, so it's already a candidate. And at the default `blockTopN=0`, **every** pair is a
candidate. In **no** configuration does candidate generation drop the aliases. They are lost one stage
later, at `decide`'s escalate threshold (`cosine < 0.72 → reject`, never adjudicated) — and **candidate-only
fusion cannot touch that**, because `decide` reads cosine, not the fused candidate score. The brief's
guard-rail ("must not be in the merge path") is exactly what makes the intervention inert here.

## Decision handed back to Dove / Sabaka

1. **Drop candidate-only lexical fusion.** It rescues nothing at the candidate stage and OR-gate/RRF can
   hurt (budget blow-up, alias loss). No config axis warranted.
2. **The signal is worth pursuing — in the *decision*, not the candidate set.** Char-trigram-overlap /
   token-Jaccard beat cosine at separating aliases from siblings (esp. code, 0.80 vs 0.53). The principled
   move is to fuse lexical into the **escalate/`decide` score** (so low-cosine high-overlap aliases reach
   the adjudicator) and/or **pass the lexical score to the adjudicator** — but that *is* the merge path the
   brief deliberately fenced off. Re-opening that fence is the actual experiment; it needs the precision
   guard re-argued (the swiss-cheese trap moves into the decision, where the LLM + digit veto must hold it).
3. If pursued, **token-Jaccard or char-trigram-overlap**, not word-BM25 (degenerate on 1–4-token names,
   confirmed by the ER blocking literature) and not RRF (rank fusion needs a candidate list it doesn't have
   at the pairwise-decision level; it regressed here).

## Gate scorecard (brief §verification)

| gate | result |
|---|---|
| aliases rescued on both corpora | ❌ **0 / 0** (cosine blocking already captures them) |
| zero sibling promotions | ✅ 0 |
| candidate budget bounded | ⚠️ RRF/weighted flat; **OR-gate +73–119%** |
| digit veto holds post-fusion | ✅ |
| local / free | ✅ |

**Spike does not pass.** Clean negative result + a redirect: the lexical channel is real, the placement
constraint is wrong. Sandbox-only; no production code or default touched.
