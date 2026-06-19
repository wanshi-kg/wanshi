#!/usr/bin/env bash
# Overnight MINE generation-model sweep.
#
# Fixed across all runs: the judge model, the embedding model, the article count,
# retrieval top-k. Only the GENERATION model varies. The first run is four-way
# (re-scores the stored KGGen/GraphRAG/OpenIE baselines under this config — those
# are generation-model-independent, so they're computed once); every later run is
# wanshi-only so it fits the per-run time budget. Per-run timeout + continue-on-
# error so one slow/broken model can't eat the night. Per-model JSON in results/sweep/.
#
#   ./scripts/sweep-mine.sh            # full sweep
#   N=15 ./scripts/sweep-mine.sh       # override article count
set -uo pipefail
cd "$(dirname "$0")/.."

DATA="${DATA:-data/mine/mine.jsonl}"
OUT="${OUT:-results/sweep}"
N="${N:-50}"
# Judge held FIXED across the sweep (only the gen model varies). gemma3:4b-cloud is
# the proven clean+fast judge: it emits a clean bare 0/1 (~0.5s/call). Bigger models
# are WORSE judges here — reasoning models (gpt-oss/qwen3) leak think-tokens, and
# gemma3:27b prose-explains; both break the tiny {evaluation} schema. Its leniency is
# a constant offset, so the relative gen-model ranking holds. (A stricter judge that
# survives capable models = a future refinement; would need a firmer output prompt.)
JUDGE="${JUDGE:-gemma3:4b-cloud}"
EMB="${EMB:-nomic-embed-text}"
TOPK="${TOPK:-15}"
RUN_TIMEOUT="${RUN_TIMEOUT:-3000}"        # 50 min cap for wanshi-only runs
RUN_TIMEOUT_4WAY="${RUN_TIMEOUT_4WAY:-7200}" # 120 min cap for the four-way baseline run

mkdir -p "$OUT"
LOG="$OUT/sweep.log"

ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }
safe(){ echo "$1" | tr '/:.' '___'; }

run() {  # run <model> <emb> <rescore-flag-or-empty> <timeout>
  local model="$1" emb="$2" rescore="$3" to="$4"
  # rescore is the FLAG: empty ⇒ four-way (baselines on), "--no-rescore-baselines" ⇒ wanshi-only.
  local suffix=""; [ -z "$rescore" ] && suffix="_4way"
  local tag; tag="$(safe "$model")_${emb%%:*}${suffix}"
  local out="$OUT/${tag}.json"
  log "START $tag  (model=$model emb=$emb N=$N rescore='${rescore:-no}')"
  local start=$SECONDS
  timeout "$to" npm run benchmark -- \
    --dataset mine --data-path "$DATA" --limit "$N" \
    --model "$model" --embeddings-model "$emb" \
    --judge-model "$JUDGE" --judge-provider ollama \
    --retrieval-top-k "$TOPK" ${rescore} \
    --output "$out" >>"$LOG" 2>&1
  local code=$?
  log "END   $tag  exit=$code  dur=$((SECONDS-start))s  -> $out"
}

log "===================== SWEEP START ====================="
log "judge=$JUDGE  emb=$EMB  N=$N  topk=$TOPK"

# 1) Four-way baseline run (nomic): KGGen/GraphRAG/OpenIE reference column + the
#    deployment-target wanshi number, all under the fixed judge.
run "gemma3:4b-cloud" "$EMB" "" "$RUN_TIMEOUT_4WAY"

# 2) nomic-vs-mxbai A/B partner: gemma3:4b-cloud wanshi under the OLD embedder.
#    Compare against the gemma3:4b-cloud@nomic wanshi from run 1.
run "gemma3:4b-cloud" "mxbai-embed-large:335m" "--no-rescore-baselines" "$RUN_TIMEOUT"

# 3) Generation-model sweep (wanshi-only, nomic). Cloud first (fast, highest
#    signal early), then local.
for M in \
  "gpt-oss:120b-cloud" \
  "qwen3.5:397b-cloud" \
  "gemma3:27b-cloud" \
  "gemma4:31b-cloud" \
  "gemma3:12b-cloud" \
  "gemma3:12b" \
  "qwen3:14b" \
  "qwen3:8b" \
  "qwen3.5:9b" \
  "gemma4:12b" \
  "qwen2.5:3b" \
  "gemma3:4b" \
; do
  run "$M" "$EMB" "--no-rescore-baselines" "$RUN_TIMEOUT"
done

log "===================== SWEEP DONE ====================="
