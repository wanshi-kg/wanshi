#!/bin/bash
# Phase C LEAN (Test 5 cross-model, budget-guarded). deepseek-v4-pro, vocab/H4.
# WIN corpora only (the gate = does +11-18pt node win replicate):
#   biored  (wanshi already 100/100 paid → resume kggen + rescore)
#   drugprot N=50, finred N=50  (replication is N-robust; halves cost vs llama's 200)
# Skip scier/code on deepseek: their LOSSES are already cross-N-confirmed on llama (Test 4),
# and scier's 18K-char papers are the priciest cell. Live credit guard between corpora.
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
export OPENROUTER_API_KEY="$KEY"
MODEL=deepseek/deepseek-v4-pro
TAG=deepseek-v4-pro
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python
FLOOR=1.20   # stop before a corpus if remaining < this (reserve for a premium probe)

remaining() {
  curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $KEY" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).data;console.log((d.total_credits-d.total_usage).toFixed(4));})' 2>/dev/null
}
guard() {
  local r; r=$(remaining)
  echo "[budget] remaining \$$r (floor \$$FLOOR) $(date +%H:%M:%S)"
  awk "BEGIN{exit !($r < $FLOOR)}" && { echo "[budget] BELOW FLOOR — stopping before next corpus"; return 1; }
  return 0
}

# args: ds dataPath cacheDir vocabFile limit cap outputName
run() {
  local ds=$1 dp=$2 cd=$3 vocab=$4 lim=$5 cap=$6 out=$7
  echo "########## $ds N<=$lim [$out] $(date +%H:%M:%S) ##########"
  local dpflag=""; [ -n "$dp" ] && dpflag="--data-path $dp"
  npx ts-node scripts/gold-compare.ts --dataset "$ds" $dpflag --cache-dir "$cd" \
    --limit $lim --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -viE "INFO.*retriev|DEBUG" | tail -4 || true
  "$VP" scripts/kggen-crossre.py --model "$MODEL" \
    --samples "$cd/samples.jsonl" --out "$cd/kggen.jsonl" 2>&1 | tail -3 || true
  npx ts-node scripts/gold-compare.ts --dataset "$ds" $dpflag --cache-dir "$cd" \
    --limit $lim --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -iE "two-way|N=|node|wanshi |kggen " | tail -8 || true
}

guard || exit 0
run biored   "" data/biored/compare-deepseek   data/biored/relations.vocab   200 8192 results/biored/${TAG}__vocab__wanshi-vs-kggen.json
guard || exit 0
run drugprot "" data/drugprot/compare-deepseek  data/drugprot/relations.vocab  50 8192 results/drugprot/${TAG}__vocab__N50__wanshi-vs-kggen.json
guard || exit 0
run finred   "" data/finred/compare-deepseek    data/finred/relations.vocab    50 8192 results/finred/${TAG}__vocab__N50__wanshi-vs-kggen.json

echo "===================== PHASE C LEAN (deepseek) COMPLETE $(date '+%Y-%m-%d %H:%M:%S') ====================="
