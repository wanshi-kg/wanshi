# Local-model benchmark — M4 (16 GB) vs L4 (rental) — final, 2026-06-28

wanshi vs KGGen, SAME local Ollama model, gold corpora. wNode/kNode = node entity-capture
semantic F1; conf = JSON-conformance; rel = related_to-share; tok/s = wanshi throughput.

## Coverage
- **L4 (RunPod):** COMPLETE — gemma3:4b + qwen3:8b × {biored,finred,redocred,crossre} × {closed,vocab}, 12 cells. drugprot crashed (unpatched loader on the baked image).
- **M4 (16 GB):** gemma3:4b COMPLETE (8 cells, incl. **drugprot** — fixed in the worktree). qwen3:8b STOPPED as impractical (see OOM finding); biored partial only.

## gemma3:4b — M4 vs L4 (the clean cross-tier comparison)
| dataset/mode | M4 wNode | L4 wNode | M4 conf | L4 conf | M4 tok/s | L4 tok/s |
|---|---|---|---|---|---|---|
| biored closed | 0.485 | 0.494 | 1.0 | 1.0 | 24.7 | 62.8 |
| biored vocab | 0.506 | 0.453 | 1.0 | 1.0 | 26.5 | 62.6 |
| finred closed | 0.448 | 0.436 | 1.0 | 1.0 | 27.3 | 57 |
| finred vocab | 0.450 | 0.438 | 1.0 | 1.0 | 26.2 | 56 |
| redocred closed | 0.687 | 0.666 | 0.967 | 1.0 | 15 | 63.7 |
| crossre closed | 0.779 | 0.738 | 1.0 | 1.0 | 27.7 | 56.7 |
| drugprot closed | 0.485 | — | 1.0 | — | 26.4 | — |
| drugprot vocab | 0.474 | — | 1.0 | — | 26.4 | — |

**Quality is hardware-independent:** M4 vs L4 wNode differ only by sampling noise (±0.01–0.05, both directions). Conformance 1.0 (M4 one blip: redocred 0.967, one chunk in a long doc). **Throughput: M4 ≈ 25–28 tok/s vs L4 ≈ 57–64 → the M4 runs the same extraction at ~40–45% of rental speed.** That is the offline-first thesis: a 16 GB laptop produces the same knowledge graph as a rented GPU, ~2.4× slower.

## The precision-stability win holds at BOTH tiers
- **M4 gemma3:4b: wanshi wins node-F1 in 8/8 cells** (kNode < wNode everywhere; KGGen over-extracts → precision craters).
- **L4: wanshi wins 11/12** (only loss: redocred/qwen3:8b, −7.4 — the doc-level arc flips for the 8B).
- So KGGen's precision-collapse is now confirmed across **4B local (M4 + L4) and 8B**, three hardware tiers.

## H5 (related_to collapse) + H4 (typed triples)
- No degeneration: related_to-share peaks ~0.45 (qwen biored, L4). vocab mode crushes it to ~0.01–0.03 (the closed schema forces typed predicates) — clean H4 signal: vocab mode lifts wanshi endTri (e.g. biored qwen vocab 0.068) while KGGen stays ~0.
- conformance 1.0 on both dense models (gemma3:4b, qwen3:8b) at both tiers → dense architectures handle the v5 closed-vocab schema; only the MoE-thinking qwen3-30b-a3b (cloud lane) ever choked.

## ★ M4 deployment-reality finding (the arm's unique contribution)
- **gemma3:4b (3.7 GB):** runs comfortably on 16 GB, concurrent (`MAX_LOADED=2`) or serialized; ~25–28 tok/s; full sweep completes.
- **qwen3:8b (5.2 GB):** **OOMs under `MAX_LOADED=2`** — swap hit 18.7 GB / 0 free when gemma+nomic+qwen pressure stacked → kernel killed the run. **Serialization (`MAX_LOADED=1`) is mandatory** for the 8B on 16 GB; it dropped swap 18.7 → ~7 GB. But even serialized, the qwen KGGen sweep is impractical (~3 h/cell, ~20 h total, swap-pressured) — so the honest answer is: **the 8B *extracts* fine on the M4 (conformance 1.0), but a full KGGen-comparison sweep on it is not a deployment-realistic workload on 16 GB.** Peak swap recorded: 18.7 GB.
- KEEP_ALIVE: `0m` (reload-per-call) was brutal for KGGen's multi-stage; `5m` warm models eliminated the thrash (gemma serialization cost ≈ 10% throughput, 24.7 → ~27 tok/s).

## Where the data lives
- L4: `results-m4/L4-SUMMARY.txt` (saved locally); 12 detail reports on the pod `/app/results` (pull before stopping the pod).
- M4: `results/<ds>/gemma3_4b__*.json` (8) + `qwen3_8b__biored_closed` (1) ; logs `results-m4/run.gemma.log`, `run.log`, `mem.log` (OOM evidence).

## Open / owed
- Pull L4 detail reports + **stop the RunPod pod** (crash-looped ~62× post-completion, ~$6/$10 spent).
- M4 qwen3:8b full sweep: resumable (caches kept) but not deployment-realistic; the OOM finding is the takeaway.
