# Fix KG generation quality: defang the merger, audit everything

## Context

Dove's autopsy of the kg-telegram-sink run (Epicure arXiv PDF + 3 articles, gemini-2.5-flash, prompt v5) found facts about `garlic` living inside the `Anthropic` entity, the central `Core` model missing entirely, and a noise relation layer. Dove hypothesized extraction-time "binding corruption."

**Investigation overturned the mechanism.** Tracing the per-chunk checkpoint sidecar (raw LLM outputs, 64 chunks) proved extraction was *correct*: `garlic` obs emitted under `garlic` (6 chunks), PyTorch under `PyTorch`, `Core` extracted in 7 variants. **1154 distinct raw entity names went into `KnowledgeMerger`; 150 came out.** The wood-chipper is the within-file merge: threshold `Math.min(entityThreshold × 0.7, 0.6)` = **0.6** on name-only Jaro-Winkler with no type/digit/embedding guard (`KnowledgeMerger.ts:244-246`). Verified with the repo's own JW: garlic↔Anthropic **0.704**, Core↔Cooc **0.733**, PyTorch↔Anthropic **0.657**, FastICA↔Anthropic **0.672** — all ≥ 0.6, all fused (first-seen name wins, loser's observations unioned in). Relation endpoints are re-keyed through the *same* fuzzy lookup (lines 314-323, 453-459), explaining `FlavorGraph contains B. Thirion`-class garbage.

A Plan-agent simulation replaying the merge over the real checkpoint confirms: within-file 0.6 → 150 entities (matches observed); 0.9 → 995; 0.9 + guards → ~1035; exact-only → 1135. Even JW 0.9 alone still wrongly fuses `Table 1↔Table 2` (0.943), `NMI↔NPMI` (0.925), `Epicure-Cooc↔Epicure` (0.917), `South Asian↔Southeast Asian` (0.901) — hence guards, not just a threshold bump.

Dove's two remaining findings are real but separate: bibliography contamination (reference-section names become entities) and document-identity mis-binding (LLM grabbed the *cited* paper's arXiv ID as the host paper's identity). Both are reader-layer fixes.

Existing assets reused: the canon-experiment-1 branch already has the embedding-clustering `Canonicalizer` + merge-log + `inspect-merges` viewer — it becomes the *legitimate* semantic dedup layer once string-merge is conservative. Checkpoint resume makes re-merging the telegram-sink corpus a **zero-LLM-cost regression harness**.

## Phases (strict order; complete one, confirm, proceed)

### Phase A — Defang KnowledgeMerger

All in `src/core/knowledge/merging/KnowledgeMerger.ts` + wiring.

1. **Remove the within-file aggressive special case** (lines 243-247): both levels use `entitySimilarityThreshold` (default 0.9 unchanged). Also remove the within-file observation-dedup aggressiveness (`× 0.8, cap 0.7`, line 279). Rationale: same-file ≠ co-reference; variant collapsing (Cooc/Epicure-Cooc/Cooc model) is canon's job.
2. **Guards in `findSimilarEntity`** (line 108) — new signature takes candidate `Entity` + map of entities:
   - *Normalized-exact fast path*: lowercase, unify `_`/`-`/dash/whitespace runs → immediate match (`black_pepper`↔`black pepper`; alone collapses 1154→1135).
   - *Digit-mismatch guard*: differing digit-token sequences (`/\d+/g`) ⇒ never fuzzy-merge (kills Table/Section/Figure/year/version fusions; mirrors canon adjudicator rule).
   - *Soft entityType guard*: both types known, different, neither `other` ⇒ require `sim ≥ max(threshold, 0.95)` (not a hard block — `Core` legitimately appears as product/technology/concept, but those hit the exact path anyway).
3. **Relation re-keying via rename map**: build `Map<oldName, finalName>` during entity merging (both levels), re-key relations through it; delete the 4 independent fuzzy `findSimilarEntity` calls (lines 314-324, 453-460). Mirrors `Canonicalizer.canonicalizeEntities`'s rename map. Endpoints never extracted as entities get dropped (existing `entityMap.has()` check) — log the dropped count.
4. **Wire the dead `enableSimilarityMerging` flag** (schema.ts:127, consumed nowhere): extend `MergeThresholds` → `MergeOptions { …thresholds, enableSimilarityMerging, onMergeRecord? }`; `false` ⇒ exact-path only. Wire in `ContainerFactory.ts` (~line 434).
5. **Merge log parity**: move the `MergeRecord` interface from `Canonicalizer.ts` to `src/core/knowledge/MergeRecord.ts` (Canonicalizer re-exports; avoids import cycle — Canonicalizer already imports from KnowledgeMerger). KnowledgeMerger emits one record per fusion via `onMergeRecord` (`method: "string-exact" | "string-jw"`); ContainerFactory appends to `string-merges.jsonl` next to the canon merge log when inspection is on. `kg-gen inspect-merges` reads it unchanged.
6. **Schema**: no new knobs, no default changes; update `entitySimilarityThreshold` description (uniform within/global; fuzzy never crosses digit mismatch).
7. **Unit tests** (`KnowledgeMerger.test.ts`): garlic/Anthropic distinct at defaults; `Table 1`/`Table 2` distinct even at threshold 0.5; `black_pepper`/`black pepper` merge; relation endpoints follow the rename map; `enableSimilarityMerging: false` ⇒ exact-only.

**Verification A:** delete `examples/kg-telegram-sink/data/output/graph.mcp-jsonl` (keep checkpoint), re-run the config. Expect: 64/64 checkpoint hits (0 LLM calls); entity count **950–1150** (sim says ~1035); `garlic` exists; a `Core`/`Epicure-Core` entity exists; `Anthropic` has zero PDF-sourced observations. Fail conditions: count ~150 (special case survived) or garlic missing (fusion persists).

### Phase D — Regression fixture (right after A; before C, which invalidates checkpoints)

- Commit the checkpoint as a fixture: `src/core/knowledge/merging/__fixtures__/telegram-sink.checkpoint.jsonl` (~748K).
- `KnowledgeMerger.regression.test.ts`: parse per-chunk `kg`s, run `mergeKnowledgeGraphs` with a throwing stub embedding provider (existing catch at KnowledgeMerger.ts:80 makes obs-dedup a deterministic no-op) + silent logger. Assert: `garlic` exists; PDF-sourced `Core` entity exists; all `garlic` obs sources = the PDF; `Anthropic` (if present) has no PDF-sourced obs; multi-source-entity contamination bound ≤ N (calibrate after A); entity count band (real post-A number ±10%).
- Written to be **red on current HEAD, green after A**.

**Verification D:** `npm test` green; reverting the A threshold change makes it red.

### Phase B — Canon as the semantic dedup layer (config-first)

- Sibling `config-canon.yaml` for telegram-sink: canonicalization enabled, `method: embeddings`, merge-log emission on. Re-merge from checkpoints (free; ~1035 local embeddings).
- Audit with `kg-gen inspect-merges` per `docs/inbox/kg-gen-canon-brief.md`: tune against the log, never against type counts.
- **Gated follow-ups, only if the log shows it**: (1) extend `agglomerativeCluster`'s decide hook to `(sim, a, b)` so the digit-mismatch guard can veto pairs (Epicure-Cooc/-Core/-Chem may sit ≥0.82 pairwise and chain via single-linkage); (2) entityType-aware veto. Complete-linkage stays out of scope.

**Verification B:** post-canon graph still has `garlic`; entity count between ~600 and Phase-A count; top-10 suspicious clusters manually defensible; no cluster mixes non-co-referent PDF/article surface forms.

### Phase C — Reader-layer hygiene (last; the content change re-bills the PDF's chunks once)

1. **References stripping**: pure util `src/core/processor/readers/stripReferences.ts` — `splitTrailingReferences(text)` finds the last `references|bibliography|works cited` heading in the final ~40% of the doc, quarantines the tail (dropped, not extracted). Apply in `MarkdownReader.read` pre-chunk and `PdfReader.read` over the page array. Config: `readers.stripReferences` boolean, **default false** (opt-in; enabled in telegram-sink config).
2. **Document identity**: `PdfReader` regexes first 2 pages for `arXiv:\d{4}\.\d{4,5}` + reads `pdfData.Meta?.Title` → `FileReadResult.metadata` (already flows to `ProcessedFile`). `KnowledgeGraphBuilder.buildFromFile` pushes one pinned `document` entity per file with the ingest-time ID as observation. No prompt changes.

**Verification C:** unit tests for `splitTrailingReferences` (markdown, PDF pages, no-references doc unchanged). One paid PDF re-extraction: bibliography person-entities (`B. Thirion`) and citation-only `PyTorch` gone/drastically reduced; `document` entity carries `arXiv:2605.22391`.

## Out of scope (logged, not absorbed)

Prompt/template changes; extraction-order inversion (canon brief Experiment 2); grounding gate; complete-linkage clustering; DoclingReader parity for references stripping; the `FileProcessor.processFiles` `findIndex(async …)`/`Promise.race` bug (real, unrelated); the "longer entityType wins" heuristic (KnowledgeMerger.ts:406-412); Dove's "collapse prose relations to `related_to`" idea — re-evaluate after A+B, since endpoint re-keying fixes much of the relation noise.

## Critical files

- `src/core/knowledge/merging/KnowledgeMerger.ts` — the fix epicenter
- `src/core/di/ContainerFactory.ts` — MergeOptions wiring (~line 434)
- `src/config/schema.ts` — description updates, `readers.stripReferences`
- `src/core/knowledge/canon/Canonicalizer.ts` + `src/shared/utils/agglomerativeCluster.ts` — MergeRecord move; gated pair-guard hook
- `src/core/processor/readers/PdfReader.ts`, `MarkdownReader.ts` — Phase C
- `examples/kg-telegram-sink/` — verification corpus + committed fixture source
