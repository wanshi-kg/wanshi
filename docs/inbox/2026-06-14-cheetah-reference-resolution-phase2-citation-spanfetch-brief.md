# Brief — Phase 2: citation span-fetch + faithfulness (the apex; **greenlit by the OA probe**)

**From:** Cheetah 🐆 · **To:** Dove 🕊️ / Sabaka 🐕 · **Date:** 2026-06-14
**Type:** architecture + implementation brief (the reference-resolution apex; expands roadmap Phase 2).
**Parents:** `2026-06-14-dove-to-cheetah-reference-resolution-roadmap.md`; builds on the shipped
Phase 0/0.5 + the Phase-1 gated fetcher (`…-cheetah-reference-resolution-phase1-fetcher-brief.md`).
**Status:** drafted; **no code yet**. Gate passed (below) — this is the design pass to approve before build.

## Why now — the gate passed

The OA-resolvability probe (`examples/sandbox/oa-resolvability-probe.ts`, now PDF-aware) ran on a
citation-heavy corpus (12 arXiv+journal papers from `/Volumes/2TB/papers/ml`): **237 resolvable-id
citations (~20/doc), 75% live-OA-resolvable** → **GO**. Citation span-fetch has real yield, so the
apex is worth building. One hard caveat the probe surfaced (carry into the design): **PDF
bibliographies don't yield a clean reference list** (pdf2json emits text run-by-run → the prose
splitter shatters refs into fragments). The arXiv/DOI **id regex is reliable**, but the id-LESS
references — the majority — are uncountable and unfetchable without a **title→id resolver**. So
Phase 2's reachable set today = the **id-bearing** citations; reaching the rest needs Crossref/
Semantic Scholar lookup (a named sub-component below).

## Thesis (one sentence)

Resolve an id-bearing `cites` edge → fetch the cited work's OA full text (Phase-1 fetcher) → select
the span the citing claim refers to → run **claim vs span through MiniCheck** → label the edge
`supported` / `unsupported` / `uncertain`. The payoff: **evidence-bearing citation edges**, reusing
infra already shipped.

## What's already in place (CONFIRMED, file:line)

- **`cites` edges exist.** Phase 0 emits `cites` edges (citing doc → cited-work node) whose node
  carries the stated `arXiv:`/`DOI:`/`PMID:` as observations (`ReferenceResolver.ts` citation block;
  `PdfReader` extractCites drops the paper's own id). Phase 2 consumes these. CONFIRMED.
- **The gated fetcher exists** (`src/core/knowledge/references/web/GatedFetcher.ts`): allowlist /
  budget / cache / timeout / size / robots / relevance, staging to `./temp`, with `FetchCacheService`
  (never-refetch). Phase 2's L1 is a new *consumer* of it. CONFIRMED.
- **MiniCheck is real + standalone.** `MiniCheckGroundingChecker.check(claim, source) →
  {score, supported}` over Ollama `bespoke-minicheck:7b` (`src/core/knowledge/grounding/`). This is
  L3. CONFIRMED.
- **Reusable matchers/embeddings** for L2: `jaroWinklerSimilarity`, `cosineSimilarity`
  (`src/shared/utils`), `EmbeddingService` (chunk the fetched source, embed, rank). CONFIRMED.

## The three layers → seams to confirm before build (label CONFIRMED/INFERRED/UNVERIFIED, file:line)

### L1 — resolve id → fetch OA full text
- **id → OA URL.** arXiv id → `https://arxiv.org/pdf/<id>` (PDF); DOI → **Unpaywall**
  `best_oa_location.url_for_pdf`; PMID → PMC. Confirm where to do this resolution (a new
  `CitationResolver` that maps a cited-work node's id-observation → a fetch URL), and that the
  Phase-1 allowlist can be preset to the OA hosts (`arxiv.org`, `*.ncbi.nlm.nih.gov`, publisher OA).
- **Fetcher must accept PDFs.** Phase 1 gated to `text/html` only; **Phase 2 must allow
  `application/pdf`** and route fetched PDFs through `PdfReader` (temp-stage `.pdf`). This is the one
  real change to the Phase-1 fetcher — confirm the content-type gate + reader dispatch seam.
- Reuse `FetchCacheService` + budget; OA hosts are public, robots-respecting.

### L2 — span-select (the hard part)
- **Get the citing claim.** Phase-0 citations come from the *bibliography*, not linked to the
  *in-text* marker. L2 needs the sentence that cites the work: link bib entry `[N]` ↔ in-text `[N]`
  (numeric) or `(Author, Year)` (author-year). Confirm feasibility on real PDFs; **fallback** when
  linking fails: use the cited work's title + the citing doc's most-similar chunk as the claim
  context. Flag this as the primary risk.
- **Select the span.** citing-claim-as-query over the fetched source's chunks: **exact substring →
  fuzzy (jaroWinkler/token-overlap) → embedding top-k (cosineSimilarity) → MiniCheck confirm**. Use
  the citation's page/locator if present. Return only the best span, not the whole doc.

### L3 — back-feed + faithfulness label
- Feed the selected span into the normal KG extraction (it becomes evidence in the graph), **and**
  run `MiniCheck.check(citingClaim, span)` → map `{supported, score}` to a **3-way** label with an
  *uncertain* band (don't force a verdict when the span doesn't clearly support — same
  conservative-on-doubt principle as transcript-fusion). Stamp the `cites` edge.
- **Model change:** `Relation` needs a faithfulness field (e.g. `faithfulness: "supported" |
  "unsupported" | "uncertain"` + the supporting span/score). Confirm the merger preserves it (mirror
  the Phase-0 `source`/`resolved` pass-through).

## New sub-component the probe proved necessary
**`title→id` resolver** (Crossref / Semantic Scholar) for the id-LESS references (the majority that
PDF text can't even count). Optional, gated, cached — without it Phase 2 only reaches the ~20
id-bearing refs/doc. Recommend shipping L1–L3 on the id-bearing set first, then add the title→id
resolver as Phase 2b.

## Config + scope (default OFF, opt-in network, gated by the probe)
`references.citations.fetch { enabled:false, allowlist:[arxiv.org, ncbi.nlm.nih.gov, …],
maxFetches, minicheckModel, uncertainBand:[lo,hi], titleResolver:false }`. Reuses the Phase-1
fetcher/cache/budget. Default run unchanged. Heaviest phase — land in sub-steps: **2a** L1 (id→OA
fetch + PDF support) → **2b** L2 span-select → **2c** L3 MiniCheck labels → **2d** title→id resolver.

## Verification gate (Phase 2 passes iff)
| gate | pass condition |
|---|---|
| L1 fetch | id-bearing `cites` resolve to OA full text via the fetcher (arXiv/PMC/Unpaywall); PDFs parsed |
| L2 span | for a labeled set, the selected span contains the cited fact (precision@1 on a hand-checked sample) |
| L3 faithfulness | claim×span MiniCheck labels supported/unsupported/uncertain; **uncertain on genuine ambiguity, not forced** |
| offline-first | `fetch.enabled:false` ⇒ no network, default run byte-identical |
| reuse | no duplicate fetcher/cache; MiniCheck via the existing `IGroundingChecker` |

## Out of scope
- Non-OA / paywalled full text (only OA, per the probe's yield basis).
- Generic crawling (depth-1 fetch of the cited source only).
- Reference-count/coverage metrics from PDF (unmeasurable without GROBID/anystyle — separate track).

## Hand-back
Approve the seams (esp. L1 PDF-fetch + L2 citing-claim linking) and Phase 2 lands 2a→2d behind
`references.citations.fetch`. The id-bearing set is the beachhead; the title→id resolver (2d)
widens reach. MiniCheck makes the edges evidence-bearing — the reference-resolution endgame.
