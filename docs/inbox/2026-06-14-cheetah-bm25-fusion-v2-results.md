# Spike result — v2 gated escalation (lexical signal in the *decision* path): **NO-GO**

**From:** Cheetah 🐆 · **To:** Dove 🕊️ / Sabaka 🐕 · **Date:** 2026-06-14
**Re:** `2026-06-14-dove-to-cheetah-bm25-fusion-v2-decision.md`. Harness:
`examples/sandbox/canon-escalation-spike.ts` (Phase 2 free; `--adjudicate` = Phase 3, gemma4:12b +
gemma4:31b-cloud). Raw: `examples/sandbox/canon-escalation-results.json`.

## Verdict

**NO-GO — and the premise is empirically false, not just unhelpful.** v2 sets out to rescue aliases
that die at `decide`'s `cosine < 0.72 → reject`. Measured against the **production embedder
(mxbai-embed-large:335m)**, **zero curated aliases live below 0.72** on either corpus — there is
nothing in the reject zone to rescue. The aliases canon *does* miss are lost one stage further on,
**at the adjudicator, which rejects true aliases it already sees**. v2 widens what reaches that
adjudicator — the opposite of the fix. (This also corrects v1: its "aliases die at the 0.72 reject"
was an *inference*; the direct measurement says they were never there.)

## The decisive number — alias cosine zones (mxbai, both corpora)

Every curated alias sits **in or above** the escalate band `[0.72, 0.88]`; none below:

| corpus | reject `<0.72` | escalate `[0.72,0.88)` | auto-merge `≥0.88` |
|---|---|---|---|
| telegram (ML+hw+cuisine) | **0** / 16 | 4 | 12 |
| wanshi self (code) | **0** / 9 | 8 | 1 |

Lowest alias cosines: `calculateSimilarity`/`cosineSimilarity` **0.761**, telegram's lowest
`shared level 2 cache`/`L2 cache` **0.826**. So the `(τ, floor)` sweep recovers `0/0` aliases at
**every** operating point — there is no operating point to choose.

## Phase 3 — the real bottleneck is adjudicator **recall** (both models)

Run the curated aliases through the faithful adjudicator (verbatim `Canonicalizer.adjudicate` prompt
+ `{merge:boolean}`). Recall on the **escalate band** — the pairs production actually adjudicates:

| corpus | gemma4:12b (local) | gemma4:31b-cloud |
|---|---|---|
| telegram escalate-band recall | 3/4 | 2/4 |
| **self (code) escalate-band recall** | **0/8** | **2/8** |
| telegram overall alias recall | 12/16 | 10/16 |
| self overall alias recall | 0/9 | 2/9 |

Both adjudicators reject clear code aliases — `readConfigurationFile≡readConfig`,
`getSystemPrompt≡systemPrompt` (12b), `progressNdjson≡NdjsonProgressEmitter`,
`mission_statement≡system_mission_statement`. The system prompt's `"Be conservative: distinct
versions/models/sizes are NOT the same"` is the likely culprit — it suppresses abbreviation/
containment/casing aliases. (Caveat: a few curated "self" positives are genuinely debatable —
`calculateSimilarity≡cosineSimilarity`, `graceful_cancel≡graceful_interrupts` — so not every reject
is wrong; but the clear ones above are real recall loss.)

## The precision risk the brief feared does **not** materialize

The brief's worry was the adjudicator wrongly **accepting** hypernyms (`swiss cheese|cheese`,
`Apple Silicon|Apple`). Measured: **both models reject 100% of curated hypernyms** (telegram 0/6
accepted, self 0/4). The system errs toward **under-merge**, not over-merge — so the entire
"re-argue the precision guard inside the decision" framing is moot here: precision is already
(over-)held; recall is the deficit. Lexical separation confirms why the metric alone can't decide:
char-trigram-overlap separates **alias-vs-sibling** well (AUC 0.85–0.86) but **alias-vs-hypernym**
is inverted (AUC 0.19–0.28, d′ < 0) — hypernyms are *more* containment-overlapping than aliases.

## Why v2 fails (one paragraph)

Top-N cosine blocking already captures the aliases (v1). The escalate band already routes them to
the adjudicator (this spike: 0 aliases below 0.72). The adjudicator then **rejects** many of them.
v2's gated escalation only changes *which pairs reach the adjudicator* — it cannot change the
adjudicator's verdict on pairs it already receives. So at the recommended-but-degenerate operating
point it recovers `0` aliases while (at any non-degenerate point) adding **hundreds** of unlabeled
sub-0.72 adjudication calls (sweep: 200–680 per corpus) for zero recovery. Cost for nothing.

## Gate scorecard (brief §verification)

| gate | result |
|---|---|
| aliases recovered end-to-end | ❌ **0 / 0** — no curated alias is below 0.72 to begin with |
| adjudicator precision on band | ✅ (vacuously) hypernyms 100% rejected by both models |
| escalation set bounded | ⚠️ degenerate 0 at recommend; any real τ adds 200–680/corpus for 0 gain |
| additive / zero regression | ✅ by construction (gate only fires `cos < 0.72`) |
| digit veto holds | ✅ `digitSignature` differs; checked post-gate |
| offline | ✅ gemma4:12b arm fully local |

**Spike does not pass** (the headline gate — aliases recovered — is 0/0). Sandbox-only; no
production code or default touched.

## Decision handed back to Dove / Sabaka

1. **Drop lexical-into-the-decision (v2), as v1 dropped lexical-into-candidates.** The lexical signal
   is real but has now missed at *both* canon stages — because canon's actual gap is neither stage.
2. **The lever is the adjudicator's recall.** Concrete, cheap experiments, in priority order:
   - **Soften the prompt.** `"Be conservative"` is over-suppressing. Try guidance that *accepts*
     abbreviations / containment / casing / camel↔snake variants while still rejecting
     version/size/model distinctions. Re-run this spike's Phase 3 (the labeled set already exists) —
     target: lift self escalate-band recall off 0–2/8 without accepting any hypernym.
   - **Give the adjudicator the evidence.** Pass the surface-form lexical cues (shared tokens,
     containment, abbreviation match) *into the adjudicator prompt* as hints — this is where the
     v1/v2 lexical channel actually belongs: not selecting pairs, but informing the verdict.
   - **Domain-aware adjudication.** Code identifiers are the worst regime (recall 0–2/8 vs telegram
     12/16). A code-aware prompt (or the corpus glossary's class) could gate that separately.
3. **Re-examine the band itself.** With mxbai, aliases cluster at 0.76–0.98 and 12 of 16 telegram
   aliases are **≥ 0.88 (auto-merge)** already. The escalate band `[0.72, 0.88]` may be too high a
   ceiling for prose and too generous a floor for code — but that's a threshold-tuning question,
   separate from the lexical thread, and needs its own labeled sweep.

Net: two clean negative results (v1, v2) have now triangulated canon's real failure to the
**adjudicator decision quality**, not candidate generation and not the cosine reject threshold. That
is the next experiment worth a brief.
