#!/bin/bash
# Phase 3 baselines: wanshi (H4 closed-vocab) vs KGGen, qwen3-30b-a3b, limit 200, two-way.
# Resumable (both tools cache per sample). Continues past a per-corpus failure.
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
export OPENROUTER_API_KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
MODEL=meta-llama/llama-3.3-70b-instruct
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python
LIMIT=200
MAXTOK=8192

run_corpus() {
  local ds=$1
  echo "############################## START $ds  $(date +%H:%M:%S) ##############################"
  local t0=$(date +%s)
  # 1) wanshi (H4) — extracts + dumps data/<ds>/compare/samples.jsonl (resumable cache)
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --limit "$LIMIT" --model "$MODEL" \
    --relation-vocab "@data/$ds/relations.vocab" --max-tokens "$MAXTOK" 2>&1 | grep -viE "INFO.*retriev|DEBUG" || true
  # 2) KGGen (free-predicate) over the same dumped sample list
  "$VP" scripts/kggen-crossre.py --model "$MODEL" \
    --samples "data/$ds/compare/samples.jsonl" --out "data/$ds/compare/kggen.jsonl" 2>&1 | tail -6 || true
  # 3) re-score → two-way table + saved report
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --limit "$LIMIT" --model "$MODEL" \
    --relation-vocab "@data/$ds/relations.vocab" --max-tokens "$MAXTOK" 2>&1 | grep -iE "two-way|HEADLINE|tool |wanshi |kggen |^[a-z].* 0\.|N=" || true
  local t1=$(date +%s)
  echo "############################## DONE  $ds  ($(( (t1-t0)/60 ))m) $(date +%H:%M:%S) ##############################"
}

for ds in biored scier code drugprot finred; do
  run_corpus "$ds"
done
echo "===================== ALL PHASE 3 RUNS COMPLETE $(date +%H:%M:%S) ====================="
