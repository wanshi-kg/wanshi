#!/usr/bin/env bash
# qwen3 size-gradient run — 1.7b / 4b on default Ollama quants. 0.6b DROPPED (smoke:
# 0/3 extraction, conformance N=0 — too small for the v5 schema, thinking-mode breaks it,
# same fate as gemma3:270m). 8b / 14b POSTPONED (slow on the heat-throttled M4 — "winter").
# Same config for every model (ctx 8192, chunking off, seed 42 — gold-compare defaults), so
# size is the only variable. Reports land in main-repo results/<ds>/ (gold-compare writes
# cwd-relative); THIS run's logs land here in results-qwen3/.
set -uo pipefail
REPO=/Volumes/2TB/wanshi-kg/wanshi
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-qwen3
mkdir -p "$RES"

# mem sampler: total ollama RSS + swap, every 30s.
(
  while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done
) >> "$RES/mem.log" 2>&1 &
MEMPID=$!
echo "[qwen3-run] start $(date) mem-sampler=$MEMPID" >> "$RES/run.log"

BENCH_ROOT="$REPO" \
RESULTS="$RES" \
VENV_KGGEN=/Volumes/2TB/wanshi-kg/wanshi-bench/.venv-kggen \
MODELS="qwen3:1.7b qwen3:4b" \
DATASETS="biored drugprot finred crossre" \
MODES="closed vocab" \
LIMIT=40 \
TS_NODE_TRANSPILE_ONLY=1 \
  bash "$REPO/scripts/bench-run.sh" >> "$RES/run.log" 2>&1

kill "$MEMPID" 2>/dev/null
echo "[qwen3-run] DONE $(date)" >> "$RES/run.log"
