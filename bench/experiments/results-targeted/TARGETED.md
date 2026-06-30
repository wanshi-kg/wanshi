# Targeted specialist cells — domain-fine-tuned model on its HOME dataset (2026-06-29)

Does a domain-fine-tuned local model beat the generalist gradient on its own domain? wanshi-only
(the axis is specialist-wanshi vs generalist-wanshi — KGGen skipped: these 8B+ models are slow
enough on the M4 that KGGen would re-create the qwen3:4b tail). N=40, ctx 8192, seed 42, same config
as the gemma3/qwen3 gradients → directly comparable. Non-reasoning SFT/instruct models only (the
thinking models — qwen3, RWKV g1g, Thinking-Camel — loop on dense extraction).

## Results

| Model (specialist) | Dataset | Mode | node-F1 | conf | rel→ | vs best generalist |
| --- | --- | --- | --- | --- | --- | --- |
| ODA-Fin-SFT-8B (Q4_K_M) | finred | closed | **0.508** | 1.00 | 0.215 | **+0.060** vs gemma3:4b 0.448 |
| ODA-Fin-SFT-8B (Q4_K_M) | finred | vocab | **0.506** | 1.00 | 0.000 | +0.056 vs gemma3:4b 0.450 |

**Generalist baselines (finred):** gemma3:4b 0.448/0.450 · gemma3:1b 0.408/0.483 · qwen3:1.7b 0.377/0.408.

## Findings (so far)

- **The finance-SFT specialist wins finred outright** — best number on record in *both* modes,
  beating every generalist. node-R is its strength (closed R 0.573). conformance 1.0, ~15–18 tok/s
  warmed up (~4.5 min/cell).
- **vocab mode confirms it's precision-disciplined, not just verbose** — related_to 0.215→0.000,
  precision 0.456→0.500, and it's the only finred cell to score relation-triples (endTri 0.037).
- **The caveat = size confound.** ODA-Fin is **8B** vs the 4B/1.7b/1b generalists, so part of the
  +0.06 is parameters, not finance-tuning. The margin is modest and gemma3:1b-vocab (0.483) is close.
  **Clean control owed:** a *generalist* 8B on finred (qwen3:8b — winter-parked) would separate
  "finance-tuned" from "bigger." Until then: specialist wins, domain-tuning contribution unquantified.

## Code three-tier study — generalist vs coder vs cybersec (@ code, 2026-06-29)

Does domain-adjacency scale on code relation-extraction? One generalist, one coder, two cybersec
models on the `code` corpus (Python repos: click/flask/requests). wanshi-only, N=40, ctx 8192.

| Model | Tier | closed nF1 | vocab nF1 | conf (cl/vc) | rel→ (cl/vc) |
| --- | --- | --- | --- | --- | --- |
| OmniCoder-9B (Q4_K_M) | **coder** | **0.195** | **0.188** | 0.80 / 0.80 | 0.032 / 0.049 |
| RedTeamer-v1 (Q8_0) | cybersec | 0.152 | 0.130 | 0.80 / 0.85 | 0.073 / 0.099 |
| WhiteRabbitNeo-V3-7B (Q4_K_M) | cybersec | 0.144 | 0.138 | 0.95 / 1.00 | 0.019 / 0.276 |
| gemma3:4b | generalist | 0.124 | 0.119 | 0.95 / 0.95 | 0.000 / 0.010 |

**Findings**

- **Domain-adjacency scales cleanly: coder > cybersec > generalist.** OmniCoder (coder) wins outright
  (0.195, **+0.071 / +57% relative** over the 0.124 generalist — recall ~doubles, 0.129 vs 0.071).
  Both cybersec models land *between* (0.144–0.152, ~+0.02–0.03 over generalist): security tuning is
  code-adjacent enough to help over generic, but a dedicated coder beats it. **Absolute scores are low
  for everyone** — code RE is genuinely hard (the gold corpus is dense Python with many call/import/
  inherit edges), so this is a *relative* story.
- **Specialist tuning costs structured-output discipline.** Both the coder and RedTeamer dropped to
  **conformance 0.80** (the generalist held 0.95), and *every* code model over-generated (maxEval
  6800–7850 — even gemma3:4b at 7598; code elicits verbosity universally). WhiteRabbitNeo kept
  conformance (0.95/1.0) but leaked `related_to` 0.276 in vocab mode (an escape-predicate wobble). So
  the specialists buy recall on their home domain but pay in JSON reliability — a real tradeoff.
- **vocab ≈ closed on code** (small drops) — unlike finred/biored, the relation vocab doesn't help much
  here (code edges are structural, not the lexical-predicate kind vocab disciplines).

## medgemma @ biored — NO-GO (the RWKV twin)

`medgemma1.5:4b` is a **verbose/reasoning medical model that loses structured-output discipline on
terse extraction** — the exact RWKV-g1g pathology, in a different model. At **ctx 8192** it
over-generates (eval_count 6603) → truncates at the wall → fails. At **ctx 32768** (the bump that
"fixed" RWKV's truncation) it instead runs past the HTTP timeout → `fetch failed` (13 of them), 0
truncations but **~4 min/chunk, 16/40 in 66 min** → projected ~5 h for both modes. **Terminated; no
usable score.** The bump relocates the failure (truncate→timeout) but never cures the over-generation
— same lesson as `[[RWKV-SHELVED]]`. *Finding stands without a number: medical-specialist tuning
toward verbose clinical reasoning is the wrong shape for constrained graph extraction.* A clean
medgemma@biored would need a much shorter request (or a no-think mode) and likely the RunPod box.

## Verdict (all targeted cells)

- **Specialist-on-home-turf WINS where the specialist is an instruct/SFT model that stays terse:**
  ODA-Fin (finance) beats generalists on finred (+0.06); OmniCoder (coder) beats them on code (+0.07).
- **Specialist tuning toward reasoning/verbosity LOSES the task:** RWKV-g1g and medgemma both
  over-generate and can't hold structured output — a specialist can *cost* you the task, not just fail
  to help. The discriminator isn't the domain, it's whether the tune preserved terse instruction-following.
- **Caveats:** size confounds persist (ODA-Fin 8B, OmniCoder 9B vs 4B generalists); absolute code
  scores are low for all; medgemma has no number.

## Owed / next cells
- **qwen3:8b @ finred** + **a generalist-9B @ code** — size-matched controls to separate "domain-tuned"
  from "bigger" (both winter-parked / deferred).
- **medgemma @ biored** — only viable with a short-output config or on RunPod (RWKV-twin verbosity).

Runner: `targeted-run.sh` (set `PAIRS="<model-tag>|<dataset>"`, optional `CTX=`/`MAXTOK=`).
