# Specialist arc — lineage-controlled (RunPod L4, 2026-06-29)

Each domain-fine-tuned model AND its **exact base**, run identically (wanshi-only, N=40, ctx 8192,
seed 42, closed+vocab) on a single L4 pod → `specialist − base` isolates the **tuning effect** with
size/family/architecture held fixed. Answers the question the M4 TARGETED study could only suggest:
*does domain fine-tuning help extraction, or was the "specialist win" just parameters?*

## The matrix (node-F1)

| corpus | model | role | closed | vocab | conf (c/v) | rel→ (c/v) |
| --- | --- | --- | --- | --- | --- | --- |
| finred | **qwen3:8b** | base | 0.476 | 0.475 | 1.0 / 1.0 | 0.449 / 0.118 |
| finred | ODA-Fin-SFT-8B | SFT | **0.524** | 0.491 | 1.0 / 1.0 | 0.171 / 0.000 |
| finred | ODA-Fin-RL-8B | RL | 0.500 | **0.542** | 1.0 / 1.0 | 0.216 / 0.000 |
| code | **Qwen3.5-9B** | base (OmniCoder's) | 0.177 | 0.173 | 0.75 / 0.80 | 0.052 / 0.070 |
| code | OmniCoder-9B | coder | 0.173 | 0.169 | 0.80 / 0.80 | 0.056 / 0.000 |
| code | **qwen2.5-coder:7b** | base (WhiteRabbit's, a coder) | 0.119 | 0.150 | 1.0 / 1.0 | 0.043 / 0.007 |
| code | **qwen2.5:7b-instruct** | base (generic ref) | 0.166 | 0.152 | 0.95 / 0.95 | 0.009 / 0.161 |
| code | WhiteRabbitNeo-V3-7B | cybersec | 0.127 | 0.135 | 1.0 / 0.95 | 0.080 / 0.359 |

## `specialist − base` deltas (the headline)

| hypothesis | comparison | closed | vocab | verdict |
| --- | --- | --- | --- | --- |
| **H-S1** finance SFT | ODA-Fin-SFT − qwen3:8b | **+0.048** | +0.016 | domain SFT genuinely helps (~+0.05) |
| **H-S2** finance RL | ODA-Fin-RL − qwen3:8b | +0.024 | **+0.067** | RL also helps; **conf stays 1.0** |
| H-S2 RL vs SFT | ODA-Fin-RL − ODA-Fin-SFT | −0.024 | +0.051 | ≈ tie; RL did **not** drift from terse |
| **H-S3** coder | OmniCoder − Qwen3.5-9B | **−0.004** | −0.004 | **ZERO** — coder ≈ its base |
| **H-S3** cybersec | WhiteRabbit − qwen2.5-coder | +0.008 | −0.015 | **ZERO** — cybersec ≈ its (coder) base |
| H-S3 cybersec vs generic | WhiteRabbit − qwen2.5:7b-instruct | −0.039 | −0.017 | **negative** — worse than a generic 7B |

## What it means

- **The M4 "specialist wins" were mostly a base/size confound — and the lineage control exposes it.**
  Once each specialist is measured against its *exact* base:
  - **Finance SFT is the one real win** (+0.05 size-isolated). Domain SFT on the right task genuinely
    adds signal. The M4 "+0.06 vs a 4B generalist" was ~all tuning, not size (the base is 8B too).
  - **Coder tuning adds ZERO on code RE** — OmniCoder is statistically identical to Qwen3.5-9B
    (−0.004). The M4 "coder beats generalist +0.07" was **entirely the base model** (Qwen3.5-9B is just
    strong at code); the coder fine-tune contributed nothing to relation extraction.
  - **Cybersec tuning adds ZERO / slightly hurts** — WhiteRabbitNeo ≈ its coder base, and **worse than
    a generic 7B-instruct** (−0.039). The M4 "cybersec beats generalist" was the Qwen2.5-Coder lineage,
    not the security tune. (This is exactly the nuance the corrected base surfaced: its base is already
    a coder.)
- **H-S2 answered cleanly: RL did NOT break terse-discipline.** Both ODA-Fin-SFT and -RL held
  **conformance 1.0**; RL even edged SFT in vocab mode (+0.051). So the medgemma/RWKV over-generation
  pathology is a property of *some* reasoning tunes, not RL/thinking per se — ODA-Fin-RL is a thinking
  model that stays terse.
- **Conformance tracks the base lineage, not the tuning.** The Qwen3.5-9B *family* drops to 0.75–0.80
  on the code corpus (base AND coder); the Qwen2.5 family holds 0.95–1.0. Code RE elicits verbosity by
  lineage. **vocab collapses `related_to` for the disciplined models** (finance → 0.0) but the cybersec/
  generic 7B *leak* it (WhiteRabbit vocab 0.359) — a discipline wobble, again base-driven.

## Bottom line
"Does domain fine-tuning help extraction, or is it just parameters?" → **Mostly the base/parameters.**
The only fine-tune that demonstrably helps wanshi extraction, size-isolated, is **finance SFT (+~0.05)**;
coder and cybersec tunes add ~0 on code RE. Dove's lineage control turned a suggestive, oversold margin
into an attributable number — and the number is humbling for the specialists.

*Caveats:* N=40, single pod/run (no seed-variance band); code absolute scores low for all (hard corpus);
deltas of ±0.02 are within plausible N=40 noise — the *signs and magnitudes* (finance +0.05 vs code ~0)
are the robust signal, not third-decimal precision. Raw per-cell logs in this dir.
