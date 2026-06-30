#!/bin/bash
# Phase C (Test 5 — cross-model replication), model = deepseek-v4-pro, vocab/H4 only.
# Waits for Phase B, then runs the full matrix at BUMPED N with isolated -deepseek cache dirs
# (fresh wanshi + fresh KGGen per model → no sample-id desync). Watch the NODE delta vs llama.
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
export OPENROUTER_API_KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
MODEL=deepseek/deepseek-v4-pro
TAG=deepseek-v4-pro
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python

echo "[phaseC] waiting for Phase B (temp/phaseB.sh) … $(date +%H:%M:%S)"
while pgrep -f 'temp/phaseB.sh' >/dev/null 2>&1; do sleep 30; done
echo "[phaseC] Phase B done — starting deepseek matrix $(date +%H:%M:%S)"

# args: ds dataPath cacheDir vocabFile limit maxTok outputName
run() {
  local ds=$1 dp=$2 cd=$3 vocab=$4 lim=$5 cap=$6 out=$7
  echo "########## $ds [$out] $(date +%H:%M:%S) ##########"
  local dpflag=""; [ -n "$dp" ] && dpflag="--data-path $dp"
  npx ts-node scripts/gold-compare.ts --dataset "$ds" $dpflag --cache-dir "$cd" \
    --limit $lim --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -viE "INFO.*retriev|DEBUG" | tail -6 || true
  "$VP" scripts/kggen-crossre.py --model "$MODEL" \
    --samples "$cd/samples.jsonl" --out "$cd/kggen.jsonl" 2>&1 | tail -3 || true
  npx ts-node scripts/gold-compare.ts --dataset "$ds" $dpflag --cache-dir "$cd" \
    --limit $lim --model "$MODEL" --relation-vocab "@$vocab" --max-tokens "$cap" \
    --output "$out" 2>&1 | grep -iE "two-way|N=|node|wanshi |kggen " | tail -8 || true
}

run biored   ""                       data/biored/compare-deepseek        data/biored/relations.vocab        200 8192  results/biored/${TAG}__vocab__wanshi-vs-kggen.json
run drugprot ""                       data/drugprot/compare-deepseek      data/drugprot/relations.vocab      200 8192  results/drugprot/${TAG}__vocab__wanshi-vs-kggen.json
run finred   ""                       data/finred/compare-deepseek        data/finred/relations.vocab        200 8192  results/finred/${TAG}__vocab__wanshi-vs-kggen.json
run scier    data/scier/train.jsonl   data/scier/compare-train-deepseek   data/scier/relations.vocab         100 32768 results/scier/${TAG}__vocab__train__wanshi-vs-kggen.json
run code     data/code/flask          data/code/flask/compare-deepseek    data/code/flask/relations.vocab    100 8192  results/code/${TAG}__vocab__flask__wanshi-vs-kggen.json
run code     data/code/requests       data/code/requests/compare-deepseek data/code/requests/relations.vocab 100 8192  results/code/${TAG}__vocab__requests__wanshi-vs-kggen.json
run code     data/code/click          data/code/click/compare-deepseek    data/code/click/relations.vocab    100 8192  results/code/${TAG}__vocab__click__wanshi-vs-kggen.json

echo "===================== PHASE C (deepseek) COMPLETE $(date '+%Y-%m-%d %H:%M:%S') ====================="
