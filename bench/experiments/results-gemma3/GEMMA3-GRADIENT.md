# gemma3 size gradient — local Ollama, default quants (2026-06-28)

wanshi vs KGGen, SAME local Ollama model, gold corpora, N=40 (M4 16 GB, thermal-throttled
in a 35 °C heat wave). Same config for every model: ctx 8192, chunking off, seed 42, temp 0 —
so **model size is the only variable**. **270m dropped** (smoke: output-loops to 6322 tokens →
truncated JSON, conformance 0.33). **12b parked** (ran at ~2 tps on the throttled M4 — finish
"in winter"). **27b is cloud-only** next (`gemma3:27b-cloud`).

> **Fresh-quant note:** re-pulling 1b/4b/12b returned **byte-identical blobs** — gemma3's Ollama
> quants are unchanged, so the "stale old-pull template" worry was unfounded; 4b/biored landed on
> **0.485**, identical to the prior M4 run (a built-in consistency check).

## The matrix (1b → 4b; 12b pending)

| Dataset | Model | Mode | wanshi nF1 | KGGen nF1 | conf | rel→ | tok/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| biored | gemma3:1b | closed | 0.255 | 0.309 | 1.00 | 0.161 | 66.6 |
| biored | gemma3:1b | vocab | 0.197 | 0.309 | 1.00 | 0.542 | 65.2 |
| biored | gemma3:4b | closed | **0.485** | 0.381 | 1.00 | 0.225 | 31.3 |
| biored | gemma3:4b | vocab | **0.509** | 0.381 | 1.00 | 0.010 | 31.9 |
| drugprot | gemma3:1b | closed | 0.304 | 0.386 | 1.00 | 0.052 | 69.9 |
| drugprot | gemma3:1b | vocab | 0.256 | 0.386 | 1.00 | 0.155 | 66.1 |
| drugprot | gemma3:4b | closed | **0.484** | 0.424 | 1.00 | 0.121 | 31.4 |
| drugprot | gemma3:4b | vocab | **0.474** | 0.424 | 1.00 | 0.024 | 31.5 |
| finred | gemma3:1b | closed | **0.408** | 0.400 | 1.00 | 0.194 | 65.2 |
| finred | gemma3:1b | vocab | **0.483** | 0.400 | 1.00 | 0.256 | 64.1 |
| finred | gemma3:4b | closed | **0.448** | 0.372 | 1.00 | 0.326 | 31.9 |
| finred | gemma3:4b | vocab | **0.450** | 0.372 | 1.00 | 0.237 | 29.8 |
| crossre | gemma3:1b | closed | 0.366 | 0.598 | 1.00 | 0.086 | 66.9 |
| crossre | gemma3:4b | closed | **0.779** | 0.698 | 1.00 | 0.330 | 31.9 |

## Findings (1b → 4b)

- **Conformance is 1.000 at both 1b and 4b** — even gemma3:1b produces valid JSON under the v5
  closed-vocab schema at every cell. The floor where it breaks is *below* 1b: **270m** (loops/truncates,
  conf 0.33). So the JSON-adherence floor sits between 270m and 1b.
- **node-F1 roughly doubles 1b → 4b on the domain corpora** (biored 0.26→0.49, drugprot 0.30→0.48)
  and on general (crossre 0.37→0.78) — a clean capability gradient.
- **The wanshi precision-win over KGGen *emerges at 4b*, not 1b.** gemma3:4b **beats KGGen node-F1 on
  all four** (biored +0.10, drugprot +0.06, finred +0.08, crossre +0.08), but gemma3:1b **loses** on
  biored/drugprot/crossre (it's too weak to recover the right entities — the discipline only pays off
  once the model is capable enough). finred is the exception (1b already edges KGGen). So the
  precision-collapse advantage has a **model-capability floor around 4b**.
- **Throughput (this thermal-throttled M4):** 1b ~65–70 tps, 4b ~30 tps, 12b ~2 tps (parked). The fan
  helped 4b recover from a mid-run swap dip; 12b is intrinsically slow here.
- **`vocab` mode** crushes related_to on 4b (biored 0.225→0.010) as expected; at 1b it's noisier
  (sometimes *raises* related_to — the small model leans harder on the fallback).

## Owed
- **gemma3:12b** — the full sweep (biored/drugprot/finred/crossre × closed/vocab) at ~2 tps; deferred
  to cooler weather. The top-end data point.
- **gemma3:27b** — cloud-only (`gemma3:27b-cloud` / Ollama Cloud), extends the gradient past the 16 GB ceiling.
