#!/bin/bash
# Phase C cross-model, remaining win corpora: drugprot + finred on deepseek-v4-pro @ N=40
# (biored already replicated: +10.2pt matched). Budget-guarded; KGGen is the ~2h/corpus bottleneck.
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
export OPENROUTER_API_KEY="$KEY"
MODEL=deepseek/deepseek-v4-pro
TAG=deepseek-v4-pro
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python
N=40
FLOOR=1.20

remaining() {
  curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $KEY" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).data;console.log((d.total_credits-d.total_usage).toFixed(4));})' 2>/dev/null
}
guard() {
  local r; r=$(remaining); echo "[budget] remaining \$$r (floor \$$FLOOR) $(date +%H:%M:%S)"
  awk "BEGIN{exit !($r < $FLOOR)}" && { echo "[budget] BELOW FLOOR — stop"; return 1; }; return 0
}
run() {
  local ds=$1 cd=$2 vocab=$3 out=$4
  echo "########## $ds N=$N [$out] $(date +%H:%M:%S) ##########"
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --cache-dir "$cd" \
    --limit $N --model "$MODEL" --relation-vocab "@$vocab" --max-tokens 8192 \
    --output "$out" 2>&1 | grep -viE "INFO.*retriev|DEBUG" | tail -3 || true
  "$VP" scripts/kggen-crossre.py --model "$MODEL" --samples "$cd/samples.jsonl" --out "$cd/kggen.jsonl" 2>&1 | tail -2 || true
  npx ts-node scripts/gold-compare.ts --dataset "$ds" --cache-dir "$cd" \
    --limit $N --model "$MODEL" --relation-vocab "@$vocab" --max-tokens 8192 \
    --output "$out" 2>&1 | grep -iE "two-way|scored|node|wanshi |kggen " | tail -8 || true
}

guard || exit 0
run drugprot data/drugprot/compare-deepseek data/drugprot/relations.vocab results/drugprot/${TAG}__vocab__N40__wanshi-vs-kggen.json
guard || exit 0
run finred   data/finred/compare-deepseek   data/finred/relations.vocab   results/finred/${TAG}__vocab__N40__wanshi-vs-kggen.json

echo "===================== PHASE C dp+fr (deepseek) COMPLETE $(date '+%Y-%m-%d %H:%M:%S') ====================="
