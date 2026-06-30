#!/usr/bin/env bash
# M4 deployment-floor run (resume): qwen3:8b only (gemma3:4b cells already complete).
# Serialized config (OLLAMA_MAX_LOADED_MODELS=1 on the server — required so the 8B doesn't
# exhaust swap → OOM, the finding from the first attempt). Samples Ollama RSS + swap.
set -uo pipefail
WT=/Volumes/2TB/wanshi-kg/wanshi-bench
cd "$WT"
mkdir -p results-m4
(
  while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done
) >> results-m4/mem.log 2>&1 &
MEMPID=$!
echo "[m4-run] mem sampler pid=$MEMPID -> results-m4/mem.log"
BENCH_ROOT="$WT" \
RESULTS="$WT/results-m4" \
VENV_KGGEN=/Volumes/2TB/wanshi-kg/wanshi/.venv-kggen \
MODELS="qwen3:8b" \
TS_NODE_TRANSPILE_ONLY=1 \
  bash /Volumes/2TB/wanshi-kg/wanshi/scripts/bench-run.sh
kill "$MEMPID" 2>/dev/null
echo "[m4-run] DONE $(date +%H:%M:%S)"
