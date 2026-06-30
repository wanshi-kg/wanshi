#!/usr/bin/env bash
# Targeted specialist-vs-generalist cells: each domain-fine-tuned model on its HOME dataset,
# wanshi-only (the comparison axis is specialist-wanshi vs generalist-wanshi; KGGen skipped —
# these 8B+ models are slow enough on the M4 that KGGen would re-create the qwen3:4b tail).
# N=40, closed+vocab (vocab auto-skipped where no relations.vocab), ctx 8192 (non-reasoning SFT
# models — no loop, no need for the RWKV 32k bump). Same config as the gradients → comparable.
#
# PAIRS: "<ollama-model-tag>|<dataset>" entries, space/newline separated. Add a pair when the
# model is pulled. Default = the ready one (ODA-Fin @ finred). medgemma@biored once pulled;
# OmniCoder@code if the code corpus is gold-compare-ready.
set -uo pipefail
REPO=/Volumes/2TB/wanshi-kg/wanshi
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-targeted
mkdir -p "$RES"
N="${N:-40}"
PAIRS="${PAIRS:-hf.co/mradermacher/ODA-Fin-SFT-8B-GGUF:Q4_K_M|finred}"

( while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done ) >> "$RES/mem.log" 2>&1 &
MEMPID=$!
trap 'kill $MEMPID 2>/dev/null' EXIT

echo "[targeted] START $(date) N=$N" | tee -a "$RES/run.log"
cd "$REPO"

run_cell() {
  local model="$1" ds="$2" mode="$3"
  local slug; slug=$(echo "$model" | tr '/:.' '_')
  local vocab=()
  if [ "$mode" = vocab ]; then
    [ -f "data/$ds/relations.vocab" ] || { echo "[targeted] skip $ds/vocab (no relations.vocab)" | tee -a "$RES/run.log"; return 0; }
    vocab=(--relation-vocab "@data/$ds/relations.vocab")
  fi
  echo "[targeted] === CELL $model @ $ds ($mode) N=$N ===" | tee -a "$RES/run.log"
  local t0; t0=$(date +%s)
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/gold-compare.ts \
    --dataset "$ds" --model "$model" \
    --provider ollama --host http://127.0.0.1:11434 \
    --embeddings-provider ollama --embeddings-model nomic-embed-text --embeddings-host http://127.0.0.1:11434 \
    --limit "$N" --per-domain 50 --ctx "${CTX:-8192}" --max-tokens "${MAXTOK:-8192}" \
    --cache-dir "data/$ds/compare/${slug}" ${vocab[@]+"${vocab[@]}"} 2>&1 \
    | tee "$RES/${slug}__${ds}__${mode}.log" \
    | grep -iE 'conformance|nodeF1|wanshi +[0-9]|Scoring [0-9]|related_to|failed chunks|truncat' \
    | tee -a "$RES/run.log"
  local t1; t1=$(date +%s)
  echo "[targeted] $model@$ds/$mode took $((t1-t0))s" | tee -a "$RES/run.log"
}

for pair in $PAIRS; do
  model="${pair%%|*}"; ds="${pair##*|}"
  echo "[targeted] pulling/ensuring $model…" | tee -a "$RES/run.log"
  ollama show "$model" >/dev/null 2>&1 || { echo "[targeted] MODEL NOT FOUND: $model — skipping" | tee -a "$RES/run.log"; continue; }
  for mode in closed vocab; do run_cell "$model" "$ds" "$mode"; done
done

echo "[targeted] DONE $(date)" | tee -a "$RES/run.log"
