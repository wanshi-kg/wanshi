#!/usr/bin/env bash
# Vanilla-baseline round (Dove's "third axis"): for every cell run THREE wanshi-side arms
# in one gold-compare invocation —
#   vanilla     plain prompt, SAME closed vocab + schema, no pipeline   (prompt ablation)
#   wanshi      the v5 prompt, no pipeline (the established lean arm)
#   wanshi-full v5 + grounding(drop) + merge                            (pipeline ablation)
# KGGen is the reference column, REUSED from cache where present (no fresh multi-stage burn).
# Two headline deltas per cell: `wanshi - vanilla` (the prompt's value) and
# `wanshi-full - wanshi` (the pipeline's value).
#
# Grid = MODELS x DATASETS x MODES (env-overridable). Same config as every prior arc
# (N=40, ctx 8192, seed 42, temp 0, chunking off) -> directly comparable to the
# gradient/specialist/M4 cells. WANSHI-ONLY dispatch (no python KGGen step).
set -uo pipefail
REPO="${BENCH_ROOT:-/app}"
RES="${RESULTS:-${BENCH_ROOT:-/app}/results}"
EMB_MODEL="${EMB_MODEL:-nomic-embed-text}"
N="${N:-40}"
MODELS="${MODELS:-gemma3:4b qwen3:8b}"
DATASETS="${DATASETS:-biored drugprot finred scier code}"
MODES="${MODES:-closed vocab}"
mkdir -p "$RES"

# mem sampler: total ollama RSS (+ macOS swap; empty on the Linux pod).
( while true; do
    rss=$(ps -axo rss,command 2>/dev/null | grep -i "[o]llama" | awk '{s+=$1} END{print s+0}')
    sw=$(sysctl -n vm.swapusage 2>/dev/null)
    printf '%s ollama_rss_mb=%d %s\n' "$(date +%H:%M:%S)" "$((rss/1024))" "$sw"
    sleep 30
  done ) >> "$RES/mem.log" 2>&1 &
MEMPID=$!
trap 'kill $MEMPID 2>/dev/null' EXIT

echo "[vanilla] START $(date) N=$N MODELS=[$MODELS] DATASETS=[$DATASETS] MODES=[$MODES] RES=$RES" | tee -a "$RES/run.log"
cd "$REPO"
echo "[vanilla] pulling embeddings ${EMB_MODEL}..." | tee -a "$RES/run.log"
ollama pull "$EMB_MODEL" 2>&1 | tail -1 | tee -a "$RES/run.log"

run_cell() {
  local model="$1" ds="$2" mode="$3"
  local slug; slug=$(echo "$model" | tr '/:.' '_')
  local vocab=()
  if [ "$mode" = vocab ]; then
    [ -f "data/$ds/relations.vocab" ] || { echo "[vanilla] skip $ds/vocab (no relations.vocab)" | tee -a "$RES/run.log"; return 0; }
    vocab=(--relation-vocab "@data/$ds/relations.vocab")
  fi
  echo "[vanilla] === CELL $model @ $ds ($mode) N=$N ===" | tee -a "$RES/run.log"
  local t0; t0=$(date +%s)
  TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/gold-compare.ts \
    --dataset "$ds" --model "$model" \
    --provider ollama --host http://127.0.0.1:11434 \
    --embeddings-provider ollama --embeddings-model "$EMB_MODEL" --embeddings-host http://127.0.0.1:11434 \
    --limit "$N" --per-domain 50 --ctx "${CTX:-8192}" --max-tokens "${MAXTOK:-8192}" \
    --vanilla --full \
    --cache-dir "data/$ds/compare/${slug}" ${vocab[@]+"${vocab[@]}"} 2>&1 \
    | tee "$RES/${slug}__${ds}__${mode}.log" \
    | grep -iE 'conformance|nodeF1|Δ |wanshi +[0-9]|vanilla +[0-9]|wanshi-full|kggen +[0-9]|Scoring [0-9]|related_to|failed chunks|truncat' \
    | tee -a "$RES/run.log"
  local t1; t1=$(date +%s)
  echo "[vanilla] $model@$ds/$mode took $((t1-t0))s" | tee -a "$RES/run.log"
}

for model in $MODELS; do
  echo "[vanilla] pulling ${model}..." | tee -a "$RES/run.log"
  ollama pull "$model" 2>&1 | tail -1 | tee -a "$RES/run.log"
  ollama show "$model" >/dev/null 2>&1 || { echo "[vanilla] MODEL UNRESOLVED: $model — skipping (finding)" | tee -a "$RES/run.log"; continue; }
  for ds in $DATASETS; do
    for mode in $MODES; do run_cell "$model" "$ds" "$mode"; done
  done
done

echo "[vanilla] DONE $(date)" | tee -a "$RES/run.log"
