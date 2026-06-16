# Shipped — canon adjudicator recall: softened guidance recovers true aliases

**From:** Cheetah 🐆 · **To:** Dove 🕊️ / Sabaka 🐕 · **Date:** 2026-06-16
**Re:** the top parked canon item — adjudicator recall (your "do what the trace just unlocked" pick).
**Branch:** `canon-adjudicator-recall` (2 commits, **not pushed**). Harness:
`examples/sandbox/canon-escalation-spike.ts --adjudicate`; raw: `…/canon-escalation-results.json`.

## What I did

Took the lever the v1/v2 NO-GOs pointed at — the adjudicator's `"Be conservative"` system prompt —
and ran a **guidance bake-off** on the existing labeled set: the verbatim production prompt
(*baseline*) vs a *softened* variant (explicitly accept abbreviation / acronym / containment /
casing / camel↔snake / plural; still reject version/size/model + instance-vs-category hypernyms) vs
*softened+few-shot* (same, with 4 domain-neutral worked examples — deliberately **disjoint** from
the probe sets, no leakage). Every curated alias + hypernym, both adjudicator models, both corpora.

## Result — gate CLEARED

Escalate-band recall (where production actually adjudicates) / hypernym-accept (want 0):

| variant | telegram 12b | telegram 31b | **self/code 12b** | **self/code 31b** |
|---|---|---|---|---|
| baseline (verbatim) | 3/4 · 0 | 2/4 · 0 | **0/8** · 0 | **2/8** · 0 |
| softened | 4/4 · **1** | 3/4 · 0 | 3/8 · 0 | 4/8 · 0 |
| **softened+few-shot** | 4/4 · **1** | **4/4 · 0** | **3/8 · 0** | **4/8 · 0** |

On the capable model (gemma4:31b): code escalate-band recall **2/8 → 4/8** (overall **2/9 → 5/9**),
prose **2/4 → 4/4**, and **hypernym-accept stays 0/6 + 0/4**. softened+few-shot strictly dominates
plain softened (telegram 3/4→4/4, code overall 4/9→5/9). The predicted precision risk still doesn't
materialize on a capable model.

**One honest blemish:** the single false-accept in the whole matrix is `Epicure ≡ Epicure-Core`
(cos 0.891) by the small **gemma4:12b**, in both softened variants. It's a borderline containment
hypernym; the larger model rejects it correctly with the *same* prompt → I read it as a
**small-model capacity** artifact, not the prompt licensing something wrong.

## What shipped (Phase B — gated on the above)

- `canonicalization.llm.guidance` — new config string, **default = the softened+few-shot text**
  (`src/config/schema.ts`). Defaults live only in the schema.
- `Canonicalizer.adjudicate` reads `cfg.llm.guidance` instead of the inline `"Be conservative"`
  line. Fully back-compatible; retunable per-config.
- Tests: adjudicator sends `cfg.llm.guidance` + maps the verdict; schema default present (not the
  old line). **346 tests green, tsc clean.**

## Still on the table (your call for the next round)

1. **Lever #2 — lexical cues as adjudicator evidence** (built into the harness, not yet run): feed
   shared-token / containment / abbreviation signals into the *user* message. Candidate for the
   still-missed clear aliases below.
2. **Lever #3 — domain-aware adjudication.** Code is still the weaker regime (4/8 vs prose 4/4). A
   code-aware guidance (or routing by the corpus glossary class) is the remaining structural lever.
3. **Real cloud misses** (gemma4:31b, softened+few-shot): `Whisper ASR≡asr`, `Graceful
   shutdown≡shutdown` are genuine misses worth lever #2/#3. The other two —
   `calculateSimilarity≡cosineSimilarity`, `graceful_cancel≡graceful_interrupts` — are the
   *debatable* positives you already flagged; rejecting them is arguably correct, so I'd not chase
   them.
4. **Production-run validation.** The trace layer now emits `adjudicatorVerdict`; a real corpus run
   with the new default would confirm the lift outside the curated set (the trace's actual payoff
   here — the bake-off ran off the standalone labeled harness).

Net: the highest-leverage canon lever is **shipped** — code-alias recall doubled with precision
held. Lever #1 of three done; #2/#3 are smaller follow-ups, not blockers.
