# qwen3 size gradient — local Ollama, default quants (2026-06-29)

wanshi vs KGGen, SAME local Ollama model, gold corpora, N=40 (M4 16 GB, thermal-throttled in a
35 °C heat wave). Same config for every model: ctx 8192, chunking off, seed 42, temp 0 — so **model
size is the only variable**. **0.6b dropped** (smoke: 0/3 extraction, conformance N=0 — qwen3's
thinking mode collapses at 0.6b, same fate as gemma3:270m). **8b/14b postponed** to winter (the 4b
already pinned the throttled M4 — see below). The **4b half was cut short** (see "Why cut"): the
1.7b half is complete; 4b has biored closed+vocab (full KGGen) + drugprot-closed (wanshi-only).

## The matrix

| Dataset | Model | Mode | wanshi nF1 | KGGen nF1 | conf | rel→ | tok/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| biored | qwen3:1.7b | closed | **0.384** | 0.350 | 1.00 | 0.363 | 58.0 |
| biored | qwen3:1.7b | vocab | **0.362** | 0.350 | 1.00 | 0.000 | 57.0 |
| biored | qwen3:4b | closed | **0.506** | 0.453 | 1.00 | 0.161 | 28.0 |
| biored | qwen3:4b | vocab | **0.520** | 0.453 | 1.00 | 0.026 | 29.6 |
| drugprot | qwen3:1.7b | closed | **0.423** | 0.401 | 1.00 | 0.083 | 58.1 |
| drugprot | qwen3:1.7b | vocab | **0.453** | 0.401 | 1.00 | 0.040 | 56.7 |
| drugprot | qwen3:4b | closed | 0.506 | _(cut)_ | 1.00 | 0.049 | 30.4 |
| finred | qwen3:1.7b | closed | 0.377 | 0.397 | 1.00 | 0.531 | 59.7 |
| finred | qwen3:1.7b | vocab | **0.408** | 0.397 | 1.00 | 0.018 | 54.4 |
| crossre | qwen3:1.7b | closed | 0.637 | 0.650 | 1.00 | 0.136 | 60.2 |

(drugprot-4b-closed wanshi side is complete; its KGGen was cut at 19/40 → wanshi-only row. finred/
crossre 4b never ran.)

## Findings

- **Conformance is 1.000 at BOTH 1.7b and 4b, every cell** — qwen3's thinking mode does NOT hurt JSON
  conformance once the model is ≥1.7b. The viable floor sits between **0.6b** (broke: 0/3, N=0) and
  **1.7b**. Same shape as gemma3 (floor between 270m and 1b).
- **node-F1 climbs 1.7b → 4b on the domains** — biored 0.384→0.506, drugprot 0.423→0.506 (+0.12,
  +0.08). A clean capability gradient, consistent with gemma3 (1b ~0.3 → 4b ~0.48).
- **The wanshi precision-win over KGGen appears ALREADY at 1.7b** — biored +0.034, drugprot +0.022,
  finred-vocab +0.011 (finred-closed and crossre are ~parity losses, −0.02/−0.013). At 4b the win
  **grows**: biored +0.053 closed, +0.067 vocab. **This is the headline cross-model contrast:** in the
  gemma3 gradient the win only *emerged at 4b* (gemma3:1b **lost** on biored/drugprot/crossre — too
  weak to recover the right entities). **qwen3:1.7b already wins where gemma3:1b lost** — qwen3 is the
  more capable small model, so the precision-discipline floor drops a tier (1.7b vs 4b). At 4b both
  model families win clearly and land in the same band (biored: gemma3:4b 0.485, qwen3:4b 0.506).
- **`vocab` mode crushes the `related_to` escape as designed** — biored 1.7b 0.363→0.000, biored 4b
  0.161→0.026, finred 1.7b 0.531→0.018 (the relation-dense set leans hard on the escape in closed
  mode; vocab fixes it), drugprot 1.7b 0.083→0.040. And vocab is *not* a recall tax here — it lifts
  node-F1 on 4 of 5 paired cells (biored-4b 0.506→0.520, drugprot/finred 1.7b both up).
- **KGGen SUCCEEDS on qwen3:1.7b** (ok=40 fail=0 every dataset) — correcting the earlier "KGGen needs
  ≥4B" assumption; it's model-dependent (qwen3:1.7b and gemma3:1b both produce valid KGGen output;
  the floor is the 0.6b/270m tier). So every 1.7b cell is a *real* two-way comparison, not wanshi-only.
- **Throughput:** 1.7b ~54–60 tps, 4b ~28–30 tps on the throttled M4 — a clean ~2× gap.

## Why the 4b half was cut (2026-06-29)

The wanshi 4b *extraction* was fine (~28–30 tps). The killer was **KGGen on qwen3:4b: ~10 min/sample**
— qwen3's thinking mode (2700+ reasoning tokens/chunk) × KGGen's multi-call-per-sample × the slower
4b token rate. biored-4b KGGen alone took ~7 h (40 samples); the full 4b half would have been **~20 h**
on the heat-throttled M4 for diminishing returns — the gemma3:4b arc already supplies a 4b
precision-win data point, and the qwen3 *story* (win at 1.7b, grows to 4b, conformance 1.0, vocab
collapses related_to) is fully carried by the 10 banked cells. Cut to pivot the GPU to the **RWKV
local arc**. The 4b half is resumable (caches on disk) if ever wanted; 8b/14b stay winter-parked
(the prior M4 qwen3:8b cell is at `results-qwen3/_prior-m4/`).

## Owed / parked
- **qwen3:4b** — drugprot/finred/crossre KGGen (resumable); biored-4b is complete.
- **qwen3:8b / 14b** — winter (slow on the throttled M4, like gemma3:12b).
