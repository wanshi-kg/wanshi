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

## Self-terminate (STOP THE POD — the budget guard)

The entrypoint stops the pod when the run finishes, via `SELF_TERMINATE` (RunPod injects a
pre-authenticated, pod-scoped `runpodctl` + `$RUNPOD_POD_ID` — no key setup). The trap is armed
**before** Ollama starts, so even a startup failure self-terminates instead of letting RunPod
restart-loop the pod (the prior ~$6 idle-loop). Modes:
- `stop` *(default)* — halt GPU billing, keep the pod + disk so you can restart and pull `/app/results`.
- `remove` — delete the pod entirely (**zero** residual billing). Use **only** with `/app/results` on a
  network volume so reports survive.
- `off` — leave it running (local/debug).

## Specialist arc — Phase 1 (wanshi-only, lineage-controlled) 🧬

Each domain-fine-tuned model AND ITS EXACT BASE on its home corpus, **wanshi-only** (no KGGen) — so
`specialist − base` isolates the tuning effect (size/family/arch held fixed). Driven by the
`scripts/targeted-run.sh` heterogeneous PAIRS runner (`RUN_MODE=targeted` selects it over the KGGen
sweep). The baked default lineup (override with `PAIRS="<tag>|<dataset> …"`):

| corpus | base (control) | specialist(s) |
|---|---|---|
| finred | `qwen3:8b` (Qwen3-8B) | ODA-Fin-SFT-8B · ODA-Fin-RL-8B (self-quantized GGUF) |
| code | `hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M` · `qwen2.5-coder:7b` · `qwen2.5:7b-instruct` | OmniCoder-9B · WhiteRabbitNeo-V3-7B |

8 models × {closed, vocab} = 16 wanshi-only cells, ~3–4 h, ~$1.50–2 on an L4. Launch env:
```
RUN_MODE=targeted   N=40   CTX=8192
SELF_TERMINATE=remove          # /app/results MUST be on a network volume
```
Reports land in `/app/results/<model-slug>__<dataset>__<mode>.log` + `run.log`. The pod's specialist
re-runs should reproduce the M4 numbers within noise (ODA-Fin-SFT ≈ 0.508/0.506, OmniCoder ≈
0.195/0.188, WhiteRabbitNeo ≈ 0.144/0.138) — a cross-environment consistency check.

> **Lineage notes:** WhiteRabbitNeo's true base is **Qwen2.5-Coder-7B** (via DeepHat-V1-7B), not generic
> Qwen2.5-7B — both controls are run (`qwen2.5-coder:7b` for the clean delta, `qwen2.5:7b-instruct` for
> the cybersec-vs-generic reference). ODA-Fin-RL is RL-on-SFT (its base is the SFT model) and ships no
> GGUF — quantize locally (llama.cpp) + upload to `hf.co/alexsabaka/ODA-Fin-RL-8B-GGUF:Q4_K_M`. The
> OmniCoder base `Qwen3.5-9B` is multimodal — smoke it before the full run.

**Phase 2 (KGGen gradient tops)** uses the default dispatch (no `PAIRS`/`RUN_MODE`) — the existing
`bench-run.sh`: `MODELS="gemma3:12b qwen3:8b" DATASETS="biored finred" MODES="closed vocab" LIMIT=40`.
Calibrate one cell first (`MODELS=gemma3:12b DATASETS=biored LIMIT=5 CALIBRATE=1`); qwen3 thinking-mode
KGGen ran ~10 min/sample locally → if brutal, run the qwen3:8b top wanshi-only via the pairs path.

## Vanilla-baseline round — the third axis (Dove `2026-06-30`) 🎚️

Breaks the "KGGen-is-a-strawman" objection: each cell runs **three wanshi-side arms** in one
`gold-compare` invocation, plus KGGen as the (cache-reused) reference column —

| column | what | the delta it feeds |
|---|---|---|
| `vanilla` | plain prompt, **same** closed vocab + schema, no pipeline | `wanshi − vanilla` = the v5 **prompt's** value |
| `wanshi` | the v5 prompt, no pipeline (the established lean arm) | (the pivot) |
| `wanshi-full` | v5 + **grounding(drop) + merge** | `wanshi-full − wanshi` = the **pipeline's** value |
| `kggen` | external tool, **reused from cache** (no re-burn) | context, not the story |

> **Why no AST seed in `wanshi-full`:** the code corpus gold *is* the outlion AST, so seeding it is
> circular (the bench scores seed-off by design); retrieval / cross-file merge / corpus glossary are
> structurally inert on independently-scored single docs. So the measurable, non-circular "pipeline"
> here = the grounding gate + merge dedup. That inertness is itself a finding.

Dispatched by `RUN_MODE=vanilla` → `scripts/vanilla-run.sh` (grid `MODELS × DATASETS × MODES`,
wanshi-only — no fresh KGGen). The run sheet (5 corpora × 2 models × 2 modes = 20 cells):
```
RUN_MODE=vanilla
MODELS="gemma3:4b qwen3:8b"
DATASETS="biored drugprot finred scier code"      # 3 win + 2 loss domains
MODES="closed vocab"   N=40   CTX=8192
SELF_TERMINATE=remove                              # /app/results MUST be on a network volume
```
Cheap round — the only new LLM cost is the `vanilla` + `wanshi-full` extractions (1 call/sample each,
local model); KGGen is reused. Reports land in `results/<ds>/<model>__<mode>__wanshi-vs-kggen.json`
(now 4 columns) + per-cell `.log`. **Stop the pod.** Build the image with `tag: vanilla`.
