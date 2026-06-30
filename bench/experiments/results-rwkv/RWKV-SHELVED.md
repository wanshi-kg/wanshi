# RWKV-7 g1g — shelved (local NO-GO), 2026-06-29

Tested `mollysama/rwkv-7-g1g` (1.5b, 2.9b local; 7.2b/13.3b untested) as a third **architecture**
(linear-attention RNN) for wanshi KG extraction on the M4. **Verdict: not viable locally for this
task** — shelved alongside the winter-parked qwen3:8b/14b + gemma3:12b. A RunPod follow-up is the
only way to fairly evaluate the bigger sizes.

## What happened
- **RWKV-7 G1 is a reasoning model** — on a meaningful fraction of samples it over-generates
  (reasoning loop) instead of emitting terse JSON.
  - At **ctx 8192** (default): the loop hits the output-token wall → `truncated at output-token
    limit` → invalid JSON → extraction fails. 1.5b smoke: **3/5 samples failed**.
  - At **ctx 32768** (the ~4× bump — `--ctx` added to gold-compare): the loop instead runs past the
    HTTP timeout → `TypeError: fetch failed`. 2.9b: timed out on multiple samples, ~21 min for <3
    samples. **The bump relocated the failure mode (truncate → timeout); it did not cure the loop.**
- **Weak even when it lands** — 1.5b's successful samples scored node-F1 **0.207** (vs qwen3:1.7b
  0.38, gemma3:1b ~0.26–0.41). A reasoning/chat model is a poor fit for constrained, terse extraction.
- **The one validated win:** RWKV is a **constant-memory RNN** — `num_ctx 32768` cost almost nothing
  (peak ollama RSS **2.7 GB** across the whole smoke). Bumping context is genuinely cheap here, unlike
  a transformer KV cache.

## The RunPod follow-up (if ever wanted)
RWKV testing belongs on the CUDA box, not the M4 — fast inference + a **longer HTTP request timeout**
(so the reasoning-gen completes instead of `fetch failed`) + ctx 32k would let 2.9b/7.2b actually be
measured. Open question that stays open: is bigger-RWKV *quality* worth it, and can g1g's reasoning be
suppressed (a no-think mode) to kill the over-generation? The `bench/` image is built; it'd need a
request-timeout knob added. Until then: shelved.

Logs: `smoke-1_5b.log`, `smoke-2_9b.log`, `smoke.log` (this dir).
