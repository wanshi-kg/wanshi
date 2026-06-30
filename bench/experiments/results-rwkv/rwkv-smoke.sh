#!/usr/bin/env bash
# RWKV-7 g1g viability smoke — all 4 local sizes, biored N=3, wanshi-only.
# The 1.5b default-config smoke (ctx/max-tokens 8192) hit the output-token wall on
# 3/5 (reasoning-loop truncation). RWKV is a constant-memory RNN, so a big num_ctx
# is cheap RAM-wise — bump ctx + max-tokens ~4x (32768) to give it room to close the
# JSON. Question: does ANY size produce valid extraction given room, and how slow?
# Sequential (smallest first) so a hopeless 1.5b shows early. No KGGen (viability first).
set -uo pipefail
REPO=/Volumes/2TB/wanshi-kg/wanshi
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-rwkv
mkdir -p "$RES"
CTX=32768
MAXTOK=32768
N=3

# mem sampler (RWKV constant-memory claim: ctx 32k should NOT blow RSS).
( while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done ) >> "$RES/mem.log" 2>&1 &
MEMPID=$!
trap 'kill $MEMPID 2>/dev/null' EXIT

echo "[rwkv-smoke] START $(date) ctx=$CTX max-tokens=$MAXTOK N=$N" | tee -a "$RES/smoke.log"

for tag in 1.5b 2.9b 7.2b 13.3b; do
  model="mollysama/rwkv-7-g1g:$tag"
  slug="rwkv_${tag//./_}"
  echo "" | tee -a "$RES/smoke.log"
  echo "==================== $model ====================" | tee -a "$RES/smoke.log"
  t0=$(date +%s)
  cd "$REPO"
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/gold-compare.ts \
    --dataset biored --model "$model" \
    --provider ollama --host http://127.0.0.1:11434 \
    --embeddings-provider ollama --embeddings-model nomic-embed-text --embeddings-host http://127.0.0.1:11434 \
    --limit "$N" --per-domain 50 --ctx "$CTX" --max-tokens "$MAXTOK" \
    --cache-dir "$REPO/data/biored/compare/_rwkv_smoke_${slug}" 2>&1 \
    | tee "$RES/smoke-$tag.log" \
    | grep -iE 'conformance|nodeF1|wanshi[ _]|Scoring|truncat|failed chunks|related_to|nodeEntity' \
    | tee -a "$RES/smoke.log"
  t1=$(date +%s)
  echo "[rwkv-smoke] $tag took $((t1-t0))s for $N samples = $(awk "BEGIN{printf \"%.0f\", ($t1-$t0)/$N}")s/sample" | tee -a "$RES/smoke.log"
done

echo "" | tee -a "$RES/smoke.log"
echo "[rwkv-smoke] DONE $(date)" | tee -a "$RES/smoke.log"
