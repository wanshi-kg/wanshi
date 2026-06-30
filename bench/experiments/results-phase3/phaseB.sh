#!/bin/bash
# Phase B (Test 4 — bump tiny-N on llama, vocab/H4 mode):
#   SciER → 80 docs (train split; robustness, NOT a test-split leaderboard number)
#   code  → 50 files (flask 20 [reuse overnight] + requests 15 + click 15)
# Distinct --output + --cache-dir per corpus so nothing clobbers the overnight test reports.
# Each corpus: wanshi extract → KGGen (same cache dir) → re-score two-way.
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
export OPENROUTER_API_KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
MODEL=meta-llama/llama-3.3-70b-instruct
SLUG=meta-llama_llama-3_3-70b-instruct
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python
LIMIT=100   # > 80 → all docs/files

# args: ds dataPath cacheDir vocabFile maxTok outputName
run() {
  local ds=$1 dp=$2 cd=$3 vocab=$4 cap=$5 out=$6
  echo "########## $ds [$out] $(date +%H:%M:%S) ##########"
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --data-path "$dp" --cache-dir "$cd" \
    --limit $LIMIT --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -viE "INFO.*retriev|DEBUG" | tail -8 || true
  "$VP" scripts/kggen-crossre.py --model "$MODEL" \
    --samples "$cd/samples.jsonl" --out "$cd/kggen.jsonl" 2>&1 | tail -3 || true
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --data-path "$dp" --cache-dir "$cd" \
    --limit $LIMIT --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -iE "two-way|N=|node|wanshi |kggen " | tail -8 || true
}

run scier data/scier/train.jsonl   data/scier/compare-train     data/scier/relations.vocab        32768 results/scier/${SLUG}__vocab__train__wanshi-vs-kggen.json
run code  data/code/requests       data/code/requests/compare   data/code/requests/relations.vocab 8192 results/code/${SLUG}__vocab__requests__wanshi-vs-kggen.json
run code  data/code/click          data/code/click/compare      data/code/click/relations.vocab    8192 results/code/${SLUG}__vocab__click__wanshi-vs-kggen.json

echo "===================== PHASE B COMPLETE $(date '+%Y-%m-%d %H:%M:%S') ====================="
