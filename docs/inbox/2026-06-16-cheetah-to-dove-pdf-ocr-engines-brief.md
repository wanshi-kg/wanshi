# Cheetah → Dove: pluggable PDF/OCR engines (marker + Mistral) — brief

**Date:** 2026-06-16 · **Branch:** `pdf-ocr-engines` (2 commits, merged to master) · **Source steal:** `../kcd`

## TL;DR

kg-gen's PDF reading is now a **pluggable engine selector**. The coarse `readers.docling: true`
boolean (which swapped the whole reader set) became `readers.pdfEngine: pdf2json | docling |
marker | mistral`. Added **MarkerPdfReader** (shells `marker_single`) and **MistralOcrReader**
(native TS HTTP). Both **degrade to pdf2json** on any failure; default run is byte-identical.
This is the "swap engines behind one interface" your kcd research explicitly named kg-gen as the
home for. Code + mocked tests are in (54 suites/323 green); **real-model e2e is pending on the M4**
(marker ~1GB install; Mistral costs $).

## What shipped

- **`readers.pdfEngine` enum** owns the PDF slot; standard readers (Rtf/Markdown/Html/Image/Office)
  always register, so office docs stay on OfficeReader. `DoclingReader` now takes an optional
  `extensions` arg → as the PDF engine it claims `.pdf` only. Retired `readers.docling` errors with
  a `readers.pdfEngine: docling` migration hint.
- **MarkerPdfReader** — `marker_single … --output_format markdown [--use_llm] [--force_ocr]`;
  `--use_llm` threads kg-gen's openai-compatible `llm` config as `OPENAI_*` env; `<pdf>.marker.md`
  sidecar cache (it's slow, ~1GB models).
- **MistralOcrReader** — native fetch (no SDK/dep): upload → signed-url → `POST /v1/ocr` → **per-page
  chunks** → delete; key `mistral.apiKey ?? $MISTRAL_API_KEY`; `<pdf>.mistral.json` sidecar so
  re-runs **never re-spend**.

**kcd's verdict, baked into the config descriptions:** Mistral OCR primary, Marker `--use_llm`
offline fallback, Docling de-favored (merges multi-header rows). Caveats carried over: **feed the
original PDF** (PDF-vs-JPEG sensitivity); tables are the failure surface.

## Open questions for the brainstorm

1. **The OCR-fidelity gap is real and unguarded.** kg-gen's grounding gate validates
   *markdown→facts*, never *PDF→markdown*. An OCR misread (10 V → 16 V) produces wrong markdown,
   the extractor faithfully lifts it, grounding passes. kcd's answer was a confidence/`verify` tier +
   cross-source corroboration — kg-gen has no parts-confidence model. **Is OCR-misread defense in
   scope for kg-gen, or explicitly punted?** (Cheapest partial: stamp `pdfEngine` onto observation
   provenance so OCR-derived facts are *queryably* lower-trust.)
2. **No bake-off ran.** kcd's SPIKE-A (score abs-max / electrical tables on litmus datasheets) is
   still owed. Worth a small **PDF-engine eval harness** (mirror `classifier-eval` / the benchmark
   harness) to pick a default per corpus type, or premature?
3. **Marker/Mistral markdown bypasses reference handling.** PdfReader does `stripReferences` +
   arXiv/citation capture; the new engines emit raw markdown and skip it. Route their output through
   MarkdownReader's reference pipeline, or niche enough to leave?
4. **Per-page provenance.** Mistral yields per-page chunks but `ChunkProvenance` has no page field.
   Add one so an OCR fact can cite "datasheet p.67" — feeds the audit/verify story. Worth it?
5. **Default engine.** Keep `pdf2json` default (portable, free) and document "switch to mistral for
   scanned/table-heavy"? Or auto-detect scanned PDFs and escalate?

## Verification status

tsc clean; jest 54/323 (mocked spawn/fetch: success / sidecar-reuse / fallback; config round-trip +
docling-migration hint; dispatch). Pending on the M4: `--pdf-engine mistral` (with `$MISTRAL_API_KEY`)
and `--pdf-engine marker` on a kcd datasheet, diffed against `datasheets/*/PDF {Marker,MistralOCR}`.
