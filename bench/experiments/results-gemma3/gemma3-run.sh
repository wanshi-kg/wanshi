#!/usr/bin/env bash
# gemma3 size-gradient run — 1b / 4b / 12b on DEFAULT Ollama quants (Q4_0; 270m is
# Q8_0 but DROPPED: the smoke showed it loops/truncates on dense extraction,
# conformance 0.33, pathologically slow). gemma3:4b reuses the M4 caches in
# main-repo data/<ds>/compare/. Same config for every model (ctx 8192, chunking
# disabled, seed 42 — gold-compare defaults), so size is the only variable.
# Reports land in main-repo results/<ds>/ (gold-compare writes cwd-relative);
# THIS run's logs land here in results-gemma3/.
set -uo pipefail
REPO=/Volumes/2TB/wanshi-kg/wanshi
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-gemma3
mkdir -p "$RES"

# mem sampler: total ollama RSS + swap, every 30s (OOM evidence — the M4 lesson).
(
  while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done
) >> "$RES/mem.log" 2>&1 &
MEMPID=$!
echo "[gemma3-run] start $(date) mem-sampler=$MEMPID" >> "$RES/run.log"

BENCH_ROOT="$REPO" \
RESULTS="$RES" \
VENV_KGGEN=/Volumes/2TB/wanshi-kg/wanshi-bench/.venv-kggen \
MODELS="gemma3:12b" \
DATASETS="biored drugprot finred crossre" \
MODES="closed vocab" \
LIMIT=40 \
TS_NODE_TRANSPILE_ONLY=1 \
  bash "$REPO/scripts/bench-run.sh" >> "$RES/run.log" 2>&1

kill "$MEMPID" 2>/dev/null
echo "[gemma3-run] DONE $(date)" >> "$RES/run.log"
