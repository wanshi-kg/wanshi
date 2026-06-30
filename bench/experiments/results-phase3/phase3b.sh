#!/bin/bash
# Phase 3b (overnight): waits for round-1 (H4) to finish, then
#   FIX 1: code corpus on llama H4 (the vocab-path bug is fixed)
#   FIX 2: SciER H4 re-run at a 32K output cap (round-1 clipped it at 8192)
#   ROUND 2: default mode (base vocab, NO --relation-vocab) on all 5 corpora.
# KGGen is mode-agnostic → default mode REUSES the round-1 kggen caches (wanshi-only re-extract).
set -uo pipefail
cd /Volumes/2TB/wanshi-kg/wanshi-bench
export OPENROUTER_API_KEY=$(grep -E "^OPENAI_API_KEY=" .env | head -1 | cut -d= -f2-)
MODEL=meta-llama/llama-3.3-70b-instruct
SLUG=meta-llama_llama-3_3-70b-instruct
VP=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen/bin/python
LIMIT=200

gc() { npx ts-node scripts/gold-compare.ts "$@" 2>&1 | grep -iE "two-way| tool |^wanshi |^kggen |N=|samples loaded|excluded|Saved" || true; }

echo "[phase3b] waiting for round-1 (temp/phase3.sh) to finish… $(date +%H:%M:%S)"
while pgrep -f 'temp/phase3.sh' >/dev/null 2>&1; do sleep 30; done
echo "[phase3b] round-1 done — starting fixes + default-mode round $(date +%H:%M:%S)"

# ── FIX 1: code (H4) — has no kggen yet, so full 3-step ──
echo "########## FIX code (H4) $(date +%H:%M:%S) ##########"
gc --dataset code --limit $LIMIT --model "$MODEL" --relation-vocab @data/code/relations.vocab --max-tokens 8192
"$VP" scripts/kggen-crossre.py --model "$MODEL" --samples data/code/compare/samples.jsonl \
  --out data/code/compare/kggen.jsonl 2>&1 | tail -3 || true
gc --dataset code --limit $LIMIT --model "$MODEL" --relation-vocab @data/code/relations.vocab --max-tokens 8192

# ── FIX 2: SciER (H4) at 32K — clear the clipped wanshi cache; kggen already cached ──
echo "########## FIX scier (H4, 32K cap) $(date +%H:%M:%S) ##########"
rm -f "data/scier/compare/wanshi.${SLUG}.vocab.jsonl"
gc --dataset scier --limit $LIMIT --model "$MODEL" --relation-vocab @data/scier/relations.vocab --max-tokens 32768

# ── ROUND 2: default mode (base vocab) on all 5; kggen reused from round 1 ──
echo "########## ROUND-2 default mode (base vocab) $(date +%H:%M:%S) ##########"
for ds in biored drugprot finred code scier; do
  CAP=8192; [ "$ds" = "scier" ] && CAP=32768
  echo "########## default $ds (cap $CAP) $(date +%H:%M:%S) ##########"
  gc --dataset "$ds" --limit $LIMIT --model "$MODEL" --max-tokens "$CAP"
done
echo "===================== PHASE 3B COMPLETE $(date '+%Y-%m-%d %H:%M:%S') ====================="
