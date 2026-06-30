# Brief — vanilla-baseline benchmark (the third axis) · RunPod run sheet

**From:** Dove 🕊️ · **To:** Sabaka (run) + Cheetah 🐆 (harness) · **Date:** 2026-06-30
**Re:** the sharpest single experiment left — does the orchestration pipeline beat a **competent
one-prompt baseline on the same model**, or was the win "structured prompting"? Breaks the
"KGGen-is-a-strawman" ambiguity. Also formalizes a reusable **vanilla arm + standard config** so every
future round is a parameter change, not a bespoke setup.
**Deferred (on purpose):** seed-variance bands, the frontier falsification cell — both real, both later.

## Why this one (and why it's worth doing properly, not tired-grinding)
Every win is currently measured against **KGGen** — which over-extracts and has no closed-vocab mode. So
"wanshi 4–10×" reads two ways: *wanshi is good* or *KGGen is bad at typed extraction*. A skeptic discounts
the whole program as a strawman until that's broken. The **same-model vanilla control** breaks it — and all
three outcomes are publishable:
- **wanshi ≫ vanilla** → the pipeline earns its keep (strong claim, honestly earned).
- **wanshi ≈ vanilla** → the win was the **closed vocab + provenance model**, not the orchestration —
  reframe the contribution honestly (still real, just *located* correctly).
- **wanshi < vanilla** → the pipeline is *hurting*. Critical to know before shipping more of it.

## ★ The whole experiment is the definition of "vanilla" — pin it first
The baseline must be the **strongest single-prompt extraction a competent person would write without the
pipeline** — not a crippled one (that's a strawman in the other direction; wanshi wins trivially and proves
nothing).

**Vanilla GETS:**
- the **same local model**,
- the **same closed-vocab schema in the prompt** (entity types + relation types),
- **one call per chunk**, same chunking,
- the ask for the **same structured JSON** graph.

**Vanilla does NOT get:** the multi-stage **merge**, the **grounding** gate, the **retrieval/glossary**
pre-pass, the **AST** seed, the **canonicalization**. → "here's the schema, extract a graph as JSON," one
good prompt, no machinery.

## The two fairness make-or-breaks (get these wrong and the result is meaningless)
1. **Vanilla MUST get the schema.** Withhold the closed vocab from vanilla but give it to wanshi and you've
   just re-run the H4 capability comparison — circular, same strawman in a new costume. The vocab is the
   *honest* half of wanshi's edge; the baseline must have it so the experiment isolates the **pipeline**
   (merge/ground/retrieve/seed), which is the part actually in question. *Vanilla-with-schema vs
   wanshi-with-schema = the pipeline's marginal value, cleanly.*
2. **Vanilla MUST be scored through the identical path.** Same node-capture metric, same semantic-match
   threshold, **same parser/normalization** as wanshi's graph output. The risk: wanshi emits a tidy typed
   graph, vanilla emits slightly messier JSON, and the *scorer* penalizes vanilla for formatting the
   harness would have normalized — smuggling a pipeline advantage into the *measurement*. **Eyeball 2–3
   vanilla outputs** to confirm it's scored on *content*, not *tidiness*.

## The table is now THREE columns — read the new delta, not the old one
**wanshi vs KGGen vs vanilla.** KGGen stays as the external-tool reference. **The headline delta is the new
one: `wanshi − vanilla`** (pipeline's marginal lift over a competent one-prompt baseline on the *same
model*). `wanshi − KGGen` is now context, not the story.

## Run sheet (all local, existing corpora, RunPod L4)
Same config as every prior arc: **N=40, ctx 8192, seed 42, temp 0, chunking off** → comparable to the
gradient/specialist cells.

| corpus | role | models | modes |
|---|---|---|---|
| biored | win domain | gemma3:4b, qwen3:8b | closed, vocab |
| drugprot | win domain | gemma3:4b, qwen3:8b | closed, vocab |
| finred | win domain | gemma3:4b, qwen3:8b | closed, vocab |
| scier | **loss** domain | gemma3:4b, qwen3:8b | closed, vocab |
| code | **loss** domain | gemma3:4b, qwen3:8b | closed, vocab |

- **Two models, deliberately** — this finally puts the **losses (scier/code) on a second model**, closing
  the win-cross-model / loss-single-model asymmetry I flagged earlier. (qwen3:8b is the doc-level-loss
  model from the L4 run — so it's the honest one to re-test the losses on.)
- **Run wanshi + vanilla every cell; KGGen reuse the cached numbers** where they exist (no need to re-burn
  KGGen's multi-stage — it's the reference column, already measured on these corpora).
- **Vanilla is wanshi-cheap** (one call/chunk, no multi-stage) → this is a **cheap round**; the only new
  compute is the vanilla arm itself.

## The reusable payoff (half the reason to do this)
The vanilla arm + the locked config become **standard harness furniture**: a baseline every future
experiment scores against, a config you don't re-derive, comparable outputs across rounds. The seed-variance
band (deferred) folds into this same arm later as one more axis. **This run pays down experiment-design
friction for the whole next phase** — which is most of why it's worth doing before the feature work.

## GPU + budget + ops
- **L4 (24 GB, ~$0.40/h)** handles all of it (≤8b, vanilla is light). Cheap round — vanilla adds little over
  the existing wanshi cells.
- **★ Stop the pod when done.** (Last run crash-looped ~62× post-completion, ~$6 wasted — auto-terminate or
  check.)

## Out of scope (deferred deliberately)
- **Seed-variance bands** — folds into the vanilla arm later; the *next* rigor step, not this one.
- **The frontier falsification cell** (the deepseek-delta-shrank-vs-llama contradiction vs "win grows with
  capability") — money-gated; high-value because it tests a *live README claim*, so it's the first thing to
  pair with rigor when benchmarking resumes — but it's a fast-follow, not now.
- **GLiNER/ReLiK** — the steal-as-component spike (a *build*, not a baseline); separate.
- More wanshi-vs-KGGen corpora, new specialist cells — closed, diminishing returns.

## Hand-back
Pin "vanilla" first (same model + same schema + one prompt, no machinery) — that definition *is* the
experiment. Enforce the two fairness gates (vanilla gets the schema; vanilla scored through the identical
path). Run the 5 corpora × 2 models, read `wanshi − vanilla` as the headline. **Stop the pod.** Then: the
benchmark-section doc edit, and switch to feature work with the harness now formalized and the resumption
threads (seed-variance, frontier cell) parked for later. This is the experiment that either earns the
pipeline or honestly relocates the contribution — and either way it's the last one that needs running before
you go build.
