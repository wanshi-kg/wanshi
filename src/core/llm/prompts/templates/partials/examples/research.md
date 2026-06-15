### Example 1: Paper introduction (proposed method + hypothesis)

Input:

## File information

Path: `papers/blocksparse-attention.md`

## Content to analyze
```
# Efficient Sparse Attention for Long-Context Transformers
Authors: A. Rivera, L. Chen — Stanford NLP Lab

We propose BlockSparse, a sparse-attention mechanism that lowers attention memory
from O(n^2) to O(n log n). We hypothesize that most attention mass is local, so a
windowed pattern loses little accuracy. On the PG-19 benchmark, BlockSparse cuts
perplexity from 33.2 to 31.8 versus a dense baseline. The design builds on the
Longformer windowed-attention approach (Beltagy et al., 2020).
```

Output:

```json
{
  "entities": [
    {
      "name": "BlockSparse",
      "entityType": "methodology",
      "observations": [
        "Sparse-attention mechanism for long-context transformers",
        "Lowers attention memory from O(n^2) to O(n log n)",
        "Cuts PG-19 perplexity from 33.2 to 31.8 versus a dense baseline"
      ]
    },
    {
      "name": "locality of attention",
      "entityType": "hypothesis",
      "observations": ["Most attention mass is local, so a windowed pattern loses little accuracy"]
    },
    {
      "name": "A. Rivera",
      "entityType": "researcher",
      "observations": ["Co-author of the BlockSparse paper"]
    },
    {
      "name": "Stanford NLP Lab",
      "entityType": "institution",
      "observations": ["Affiliation of the BlockSparse authors"]
    },
    {
      "name": "PG-19",
      "entityType": "dataset",
      "observations": ["Long-document language-modeling benchmark used for evaluation"]
    },
    {
      "name": "Longformer",
      "entityType": "methodology",
      "observations": ["Windowed-attention approach of Beltagy et al., 2020"]
    }
  ],
  "relations": [
    { "from": "BlockSparse", "to": "locality of attention", "relationType": ["tests"] },
    { "from": "BlockSparse", "to": "PG-19",                  "relationType": ["uses"] },
    { "from": "BlockSparse", "to": "Longformer",             "relationType": ["builds_upon"] },
    { "from": "A. Rivera",   "to": "BlockSparse",            "relationType": ["produces"] },
    { "from": "A. Rivera",   "to": "Stanford NLP Lab",       "relationType": ["member_of"] }
  ]
}
```

Note: the perplexity figures (33.2 → 31.8) and the `O(...)` bounds are measured
values — observations on the method, not their own nodes. `methodology` is reused
for both the proposed method and the prior one it builds on; the type set stays small.

---

### Example 2: Experiment + statistical result (with prior context — extend, don't duplicate)

Input:

## File information

Path: `papers/blocksparse-attention.md`
Chunk 4 of 7

## Already extracted (do not re-emit)

- **BlockSparse** (methodology): Sparse-attention mechanism for long-context transformers
- **PG-19** (dataset): Long-document language-modeling benchmark used for evaluation

## Content to analyze
```
We ran an ablation across 4 random seeds comparing BlockSparse against the dense
baseline. The perplexity reduction was significant (paired t-test, p < 0.01).
Throughput, measured in tokens/second, rose 2.3x at 16k context length.
```

Output:

```json
{
  "entities": [
    {
      "name": "BlockSparse ablation",
      "entityType": "experiment",
      "observations": [
        "Ablation across 4 random seeds against the dense baseline",
        "Throughput rose 2.3x at 16k context length"
      ]
    },
    {
      "name": "paired t-test",
      "entityType": "statistical_test",
      "observations": ["Perplexity reduction significant at p < 0.01"]
    },
    {
      "name": "throughput",
      "entityType": "variable",
      "observations": ["Measured in tokens/second"]
    }
  ],
  "relations": [
    { "from": "BlockSparse ablation", "to": "BlockSparse",   "relationType": ["validates"] },
    { "from": "BlockSparse ablation", "to": "throughput",    "relationType": ["measures"] },
    { "from": "BlockSparse ablation", "to": "paired t-test", "relationType": ["uses"] }
  ]
}
```

Note: `p < 0.01`, `4 seeds`, and `2.3x` are observations, not nodes. `BlockSparse`
is referenced by its exact prior name in a relation without being re-emitted (it
gained no new fact here). One predicate per edge — no `["validates", "tests"]`.

---

### Example 3: Related work (citations + a contradicted finding)

Input:

## File information

Path: `papers/blocksparse-attention.md`
Chunk 6 of 7

## Already extracted (do not re-emit)

- **BlockSparse** (methodology): Sparse-attention mechanism for long-context transformers

## Content to analyze
```
## Related Work
Child et al. (2019) introduced fixed sparse-attention patterns. Smith et al. (2021)
reported that sparsity yields no perplexity gain at scale — a claim our PG-19
results contradict.
```

Output:

```json
{
  "entities": [
    {
      "name": "Sparse Transformer (Child et al., 2019)",
      "entityType": "publication",
      "observations": ["Introduced fixed sparse-attention patterns"]
    },
    {
      "name": "Smith et al. (2021)",
      "entityType": "publication",
      "observations": ["Reported that sparsity yields no perplexity gain at scale"]
    }
  ],
  "relations": [
    { "from": "BlockSparse", "to": "Sparse Transformer (Child et al., 2019)", "relationType": ["cites"] },
    { "from": "BlockSparse", "to": "Smith et al. (2021)",                      "relationType": ["contradicts"] }
  ]
}
```

Note: a cited prior work is a `publication`; `cites` records the reference, while
`contradicts` records the disagreement in findings — two distinct predicates, never
stacked. Direction is consistent (citing work → cited work).

---

### Example 4: Pure notation → empty graph

Input:

## File information

Path: `papers/blocksparse-attention.md`
Chunk 7 of 7

## Content to analyze
```
$$ \mathcal{L}(\theta) = -\sum_{i=1}^{N} \log p_\theta(x_i) + \lambda \lVert \theta \rVert_2^2 $$
where $\theta \in \mathbb{R}^d$ and $\lambda > 0$.
```

Output:

```json
{ "entities": [], "relations": [] }
```

Note: an isolated equation with no named concept to attach it to yields nothing —
bare symbols and formulas are observations at most, never nodes.
