# RunPod local-model benchmark — operator runbook

The local-model arm: **wanshi vs KGGen on the SAME local Ollama model**, across the gold corpora, on a rented
**RunPod L4** (24 GB VRAM, ~$0.40/h, ~$10 budget ≈ 25 h). The image is reproducible; the sweep
(models/datasets/modes/limit) is chosen by env vars / a `PHASE` preset at launch — no rebuild to change the lineup.

## What this run is FOR (so you can front-load by value)

The domain node-anomaly is verified and **model-stable across two dense ~70B models** (llama-3.3-70b, deepseek-v4-pro).
The single highest-value thing this run adds is **H-L1 — the model-invariance capstone:** if KGGen's precision-collapse
*still* appears on a quantized **gemma3:4b** (a maximally-different model), "model-stable" is earned as "model-invariant"
across 4B→70B. Secondary, nearly-free outputs the cloud runs can't give: **JSON-conformance** (which architectures can
even do the task — dense gemma/qwen vs the MoE-thinking qwen that choked), **`related_to`-share** (does the 4B collapse
to the escape predicate), and **throughput** (deployment speed, rental ≠ M4). The run is **resumable**, so the strategy
is **calibrate one cell, then run the highest-value block first.**

## One-time: build & publish the image (GitHub Actions → GHCR)

1. **Push the harness branch.** `git push origin bench-image` — it carries the dataset loaders, `scripts/gold-compare.ts`,
   `scripts/bench-run.sh`, and the `bench/` files (the workflow builds from this branch). `data/` stays gitignored.
   *(Optionally also push `corpus-sourcing`, the harness's home lane.)*
2. **Host the corpora privately.** The private repo `<owner>/wanshi-bench-data` already exists but is **empty** — populate
   it: from the bench worktree run `scripts/pack-corpora.sh` (produces `corpora.tar.zst`, ~tens of MB; REBEL excluded,
   drugprot/biored/finred included), commit that file to the data repo. Add a repo secret **`BENCH_DATA_TOKEN`** (a token
   that can read the private data repo) to the harness repo.
3. **Run the workflow:** Actions → *Build benchmark image (GHCR)* → `Run workflow` (ref **`bench-image`**, `tag: latest`,
   `include_corpora: true`). Builds `linux/amd64` → `ghcr.io/<owner>/wanshi-bench:latest`.
4. **Set the package private:** GHCR → `wanshi-bench` package → *Package settings* → visibility **Private** (corpora are
   baked in). *Data-free alternative:* `include_corpora: false`, keep public, upload the tarball to the pod (`CORPORA_TAR`).

## Per-run: launch the pod

5. **Create the pod:** RunPod → GPU **L4 (24 GB)** → *Custom image* `ghcr.io/<owner>/wanshi-bench:latest`.
   - **Registry creds** (private image): add your GHCR username + a `read:packages` PAT.
   - *(Recommended)* attach a **network volume** at `/root/.ollama` so pulled models persist across stop/restart, and
     mount **`/app/results`** on the volume so reports survive a dead pod.
   - **No API key needed** for the local arm.

## The phased sweep (ordered by value — buy later phases only if calibration allows)

Drive each phase with the `PHASE` env (a preset that sets MODELS/DATASETS/MODES/LIMIT). Run them in order:

| `PHASE=` | cells | answers |
|---|---|---|
| **`sanity`** | gemma3:4b · semeval · closed · N=20 | pipeline works (~minutes) |
| **`calibrate`** | gemma3:4b · biored · closed · **N=5**, both tools timed | **wall-clock/sample → compute cells/24h before spending** |
| **`capstone`** ⭐ | {gemma3:4b, qwen3:8b} × {biored, drugprot, finred} × {closed, vocab} × N=40 | **H-L1** (4B invariance) + **H-L3** (dense gemma vs dense qwen) + typed-capability. *If you run nothing else, run this.* |
| **`gradient`** | {gemma3:1b, gemma3:4b, gemma3:12b} × biored × {closed, vocab} × N=40 | **H-L2** capability gradient (does the gap grow or shrink as the local model scales?) |
| **`docarc`** | {gemma3:4b, qwen3:8b} × redocred × {closed, vocab} × N=30 | the doc-level precision arc at small scale |
| **`continuity`** | gemma3:4b × crossre × {closed, vocab} × N=20 | general-benchmark continuity (per-domain-stratified → WS-01-safe) |

```
# Phase 0 — sanity, then calibrate and READ the timing before going further:
PHASE=sanity      ./   # (the entrypoint runs bench-run.sh; just set the env on the pod)
PHASE=calibrate   ./   # prints "TIMING wanshi …" + "TIMING kggen …" per-sample seconds
# Phase 1 — the must-have:
PHASE=capstone    ./
# Phase 2+ — only if the calibration math says the budget allows:
PHASE=gradient    ./
PHASE=docarc      ./
```
For a fully custom run, omit `PHASE` and set `MODELS` / `DATASETS` / `MODES` / `LIMIT` directly (defaults:
`MODELS="gemma3:4b qwen3:8b"`, `DATASETS="biored drugprot finred redocred crossre"`, `MODES="closed vocab"`, `LIMIT=40`,
`REDOCRED_LIMIT=30`). The entrypoint starts Ollama, pulls the models, and runs the matrix. **Resumable** — restart the
pod (same volume) and it skips cached cells.

## Collect results

6. Reports land in `/app/results/<dataset>/<model>__<mode>__wanshi-vs-kggen.json` plus `/app/results/SUMMARY.txt` and
   `/app/results/sweep.log`. The **SUMMARY** columns: `wNode kNode` (node-capture F1, the headline), `wTri` (wanshi
   triple F1), **`conf`** (JSON-conformance), **`rel`** (`related_to`-share), **`tok/s`** (wanshi throughput, rental ≠ M4).
   The per-cell JSON also has `extraction.{conformanceRate,failedChunks,completionTokensPerSec}` and per-tool node P/R.
   Pull back with `runpodctl receive` / the file browser.
7. **Watch spend:** ~$0.40/h. KGGen's multi-stage on a slow L4 is the cost driver — that's *why* you calibrate first.
   `OLLAMA_MAX_LOADED_MODELS=2` keeps gen + embed resident; `OLLAMA_KEEP_ALIVE=30m` avoids reloads between same-model cells.

## Notes
- **Models ≥4B for KGGen.** KGGen's structured parse fails on sub-1B models (smollm2 only proves plumbing). gemma3:1b in
  the gradient is a *wanshi-side* point (conformance/collapse); KGGen may emit nothing there — the cell degrades to a
  wanshi-only row, which is fine.
- KGGen runs on the **same local model** via LiteLLM's `ollama_chat/` provider (a dummy `OPENROUTER_API_KEY` is set
  automatically; Ollama ignores it). It is **cached once per model×dataset** and scored against both modes (KGGen has no
  mode) — it does not re-run per mode.
- Throughput is **rental speed ≠ M4 speed**; the M4 feasibility/OOM floor is a separate, still-owed run.
- The gold CrossRE cell is domain-stratified (`--per-domain 50`), so it is unaffected by the WS-01 loader bug.
