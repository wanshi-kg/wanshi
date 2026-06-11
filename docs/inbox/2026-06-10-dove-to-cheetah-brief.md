# kg-gen — Brief: Configurable pipeline + global canonicalization

**Audience:** Cheetah (implementation)

---

## Status — independent verification of A+B against the live deployed graph

Cross-checked the two live graphs via the `memory-sink` MCP (not the plan's
simulation — the actual graphs the bot is serving). Arms:

- **A** = `config.yaml` — Phase A defanged merger, no canonicalization stage.
- **B** = `config-canon.yaml` — A + Phase B hybrid (embeddings@0.88 / LLM-adjudicated
  escalation band `[0.72, 0.88]`).

| metric | A | B | plan target |
|---|---|---|---|
| entities | 1064 | 980 | A: 950–1150 (sim ~1035) ✓ · B: ~600–A ✓ |
| relations | 1432 | 1400 | — |
| entity types / rel types | 18 / 19 | 18 / 19 | controlled vocab held ✓ |
| self-loops / dangling rels | 0 / 0 | 0 / 0 | referential integrity ✓ |
| `garlic` present | yes (4 obs) | yes (4 obs) | Verification A ✓ |
| `Anthropic` food-contaminated obs | 0 / 10 | 0 / 10 | Verification A ✓ |
| bare-author non-authorship rels | 0 | 0 | endpoint re-key ✓ |

**Phase A passes its verification conditions on the deployed graph.** The
wood-chipper (1154→150) is gone; `garlic`/`Anthropic` are clean; the
`FlavorGraph contains B. Thirion`-class relation garbage is eliminated by the
rename-map re-keying. This is the big win and it landed.

**Correction to the earlier autopsy framing:** the 118 bare bibliography-author
person entities are **not** a Phase-A regression — they are the un-run Phase C.
Neither config sets `readers.stripReferences: true`, so references are still in
the extraction window by design. "Deferred," not "broken." Forward items below.

## What Phase B (canon) actually did — and where it stopped short

Canon is a strict subset operation here: 980 ⊂ 1064, **0 entities added**, 43
survivors gained observations (real merges, not deletions; e.g. `Core model`
21→39 absorbing bare `Core`). Edge cleanup is correct (0 edges point at removed
nodes).

But it resolved **one** FlavorGraph variant family and skipped the rest:

| pair | A | B (post-canon) |
|---|---|---|
| `Core` / `Core model` | both | merged → `Core model` ✓ |
| `Chem` / `Chem model` | both | **both survive** ✗ |
| `Cooc` / `Cooc model` | both | **both survive** ✗ |
| `Epicure` / `Epicure models` | both | **both survive** ✗ |
| `AI` / `AI models` | both | both survive — *plausibly correct* (field vs artifacts) |

The config comment already predicted 0.88 misses `Cooc/Cooc model/Epicure-Cooc`.
The escalation band is supposed to catch these. It didn't fire (or the
adjudicator rejected them). This is the prime canon-tuning target, not a
threshold bump — see NR-3.

## Next round (strict order; each gated on its verification)

### NR-1 — Enable + ship Phase C references stripping  [highest leverage]

The single largest remaining noise source. Live counts:
- **118 / 126 person entities (94%) are bare citation authors** — zero obs,
  connected only by `produces`→title and `member_of`→citation-string.
- **12 citation-string entities** promoted to nodes (`Ahn et al. [2011]`,
  `Mikolov et al. [2013]`, …) with authors hanging off via `member_of`.
- ~42% of all `produces` edges (≈121/285) are author→title bibliography edges.

Action:
1. Confirm `splitTrailingReferences` (Phase C item 1) is implemented per spec —
   last `references|bibliography|works cited` heading in trailing ~40%, quarantine
   tail, drop (not extract). Apply in `MarkdownReader.read` and `PdfReader.read`.
2. **Set `readers.stripReferences: true` in both `config.yaml` and
   `config-canon.yaml`.** (It is currently unset in both — this is why the
   contamination persists even if the util exists.)
3. One paid PDF re-extraction per Verification C (this re-bills the PDF chunks
   once; do it before NR-3's re-merge so canon audits the clean corpus).

**Verification NR-1:** bare-author person count drops from 118 toward single
digits; citation-string entities (`* et al. [YYYY]`) → 0; `produces` edge count
falls by ≈120. `garlic`, `Core model`, real-content entities unaffected.

### NR-2 — Phase C document identity (host-paper pinning)

Confirmed broken on the live graph: the **only** two arXiv IDs present
(`2503.07891`, `1702.01417`) belong to *cited* papers leaked from bibliographies.
The host paper's own identity (`arXiv:2605.22391` per the plan) is **absent** —
no pinned `document` entity carries it.

Action: `PdfReader` regexes first 2 pages for `arXiv:\d{4}\.\d{4,5}` + reads
`pdfData.Meta?.Title` → `FileReadResult.metadata`;
`KnowledgeGraphBuilder.buildFromFile` pushes one pinned `document` entity per
file with the ingest-time ID as observation. No prompt changes.

**Verification NR-2:** exactly one pinned `document` entity per ingested file,
carrying the ingest-time ID; cited-paper IDs no longer the only arXiv IDs in the
graph. (Stacks cleanly with NR-1, which removes most cited-paper doc nodes anyway.)

### NR-3 — Canon variant-family audit (merge-log driven)

Re-merge the post-NR-1 corpus from checkpoints (free local embeddings) with
`inspection.emitMergeLog: true`, then audit `merges.jsonl` — **not type counts**
(config §5). Targeted question for each surviving X/`X model` pair: did it (a)
fall outside `[0.72, 0.88]` so it never escalated, or (b) escalate and get
rejected by the LLM adjudicator?

- If (a): the embedding metric underweights the `" model"` suffix on short
  strings → widen the lower escalation bound or add the normalized-suffix fast
  path from the merger's guard set (`X` vs `X model` after suffix-strip = exact).
- If (b): adjudicator prompt is too conservative on ablation-variant naming →
  tune with FlavorGraph variant examples.

Then evaluate the plan's gated follow-ups **only if the log shows the need**:
extend `agglomerativeCluster`'s decide hook to `(sim, a, b)` for the
digit-mismatch veto (Epicure-Cooc/-Core/-Chem may chain via single-linkage), and
the entityType-aware veto. Keep `AI`/`AI models` split unless the log says
they're genuinely co-referent — that one is probably correct as-is.

**Verification NR-3:** every surviving near-variant pair has a defensible
merge-log entry (merged-with-reason or kept-with-reason); no cluster mixes
non-co-referent surface forms; entity count lands in `[~600, post-NR-1]`.

### NR-4 — `related_to` gate (the plan's "re-evaluate after A+B")

153 `related_to` edges remain (~11% of the relation layer) — semantically empty.
The plan deferred Dove's "collapse prose relations to `related_to`" pending A+B;
A+B are done, so this gates now. **Note the direction:** the problem is the
*opposite* of Dove's framing — `related_to` is already the junk bucket, so the
question is whether these 153 should be **dropped or re-typed**, not whether to
route more relations into it. Sample ~30, classify (droppable vs recoverable to a
real predicate), decide policy from the sample.

## Confirm-only (can't verify from the graph — repo-side)

- Phase D regression fixture committed (`telegram-sink.checkpoint.jsonl`) and the
  test is **red on pre-A HEAD / green after A**? The graph can't show this.
- `enableSimilarityMerging` flag actually wired (`false` ⇒ exact-only path)?
- `KnowledgeMerger.test.ts` cases green (garlic/Anthropic distinct at defaults;
  `Table 1`/`Table 2` distinct even at 0.5; `black_pepper`/`black pepper` merge)?

## Out of scope (carry forward, unchanged)

Prompt/template changes; extraction-order inversion (canon brief Experiment 2);
runtime grounding gate; complete-linkage clustering; DoclingReader references
parity; the `FileProcessor.processFiles` `findIndex(async …)`/`Promise.race` bug
(real, unrelated); "longer entityType wins" heuristic
(`KnowledgeMerger.ts:406-412`).
