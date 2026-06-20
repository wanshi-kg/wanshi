#!/usr/bin/env bash
# MINE comparative sweep on OpenRouter — the credibility table (Dove's amendment brief).
#
# Why OpenRouter (not the local/ollama-cloud sweep): reproducible, no per-model
# entitlement walls, every model has structured_output ✓. The local ollama sweep is a
# SEPARATE concern (deployment reality) and still owed — see scripts/sweep-mine.sh.
#
# Fixed across all runs (fairness): the judge (deepseek-v4-flash on OpenRouter), the
# embedding model (local nomic), N, top-k, and the ALIGNED data file. The first run is
# four-way (re-scores the stored KGGen/GraphRAG/OpenIE baselines once — they're gen-model
# independent); every later run is wanshi-only. Per-article checkpoint (built into the
# runner) + per-run watchdog + --max-cost guard, so a crash/slow/expensive model can't
# eat the budget. Per (model,arm) JSON in results/openrouter/.
#
# Arms (the canonicalization-tax curve): v4.5 (legacy) · v5 (default closed) · open
# (--open-predicate, free vocab) · glossary (v5 + --corpus-profiling, the product).
#
#   ./scripts/sweep-openrouter.sh                  # full matrix
#   N=20 ./scripts/sweep-openrouter.sh             # quick
#   ONLY_CURVE=1 ./scripts/sweep-openrouter.sh     # skip the SOTA glossary cells
set -uo pipefail
cd "$(dirname "$0")/.."

HOST="${HOST:-https://openrouter.ai/api/v1}"
DATA="${DATA:-data/mine/mine.aligned.jsonl}"
OUT="${OUT:-results/openrouter}"
N="${N:-70}"
EMB="${EMB:-nomic-embed-text}"            # local, free
JUDGE="${JUDGE:-deepseek/deepseek-v4-flash}"  # FIXED cloud judge (structured_output ✓)
TOPK="${TOPK:-15}"
MAXCOST="${MAXCOST:-3}"                   # per-run USD cap (cost meter → graceful stop)
RUN_TIMEOUT="${RUN_TIMEOUT:-4500}"

# Model tiers (all structured_output ✓ on OpenRouter, verified 2026-06-20).
CURVE_MODELS=(${CURVE_MODELS:-\
  "deepseek/deepseek-v4-flash" \
  "qwen/qwen3.5-9b" \
  "google/gemma-4-31b-it" \
  "deepseek/deepseek-v4-pro" \
  "minimax/minimax-m3"})
SOTA_MODELS=(${SOTA_MODELS:-"anthropic/claude-sonnet-4.6" "openai/gpt-5.4"})
ARMS=(${ARMS:-v4.5 v5 open})

mkdir -p "$OUT"
LOG="$OUT/sweep.log"
ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }
safe(){ echo "$1" | tr '/:.' '___'; }

# run <model> <arm> <rescore-flag-or-empty>
run() {
  local model="$1" arm="$2" rescore="$3"
  local promptflag="--prompt-version v5" extra=""
  case "$arm" in
    v4.5)     promptflag="--prompt-version v4.5" ;;
    v5)       promptflag="--prompt-version v5" ;;
    open)     promptflag="--prompt-version v5"; extra="--open-predicate" ;;
    glossary) promptflag="--prompt-version v5"; extra="--corpus-profiling" ;;
  esac
  local tag; tag="$(safe "$model")__${arm}"; [ -z "$rescore" ] && tag="${tag}_4way"
  local out="$OUT/${tag}.json"
  log "START $tag  (model=$model arm=$arm N=$N rescore='${rescore:-4way}' maxcost=$MAXCOST)"
  local start=$SECONDS

  npm run benchmark -- \
    --dataset mine --data-path "$DATA" --limit "$N" \
    --provider openai --host "$HOST" --model "$model" \
    --embeddings-model "$EMB" \
    --judge-provider openai --judge-host "$HOST" --judge-model "$JUDGE" \
    --retrieval-top-k "$TOPK" $promptflag $extra ${rescore} \
    --cost --max-cost "$MAXCOST" \
    --output "$out" >>"$LOG" 2>&1 &
  local pid=$!
  ( sleep "$RUN_TIMEOUT"; kill -TERM "$pid" 2>/dev/null; sleep 5; pkill -KILL -f "scripts/benchmark.ts" 2>/dev/null ) &
  local killer=$!
  wait "$pid" 2>/dev/null; local code=$?
  kill -TERM "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  log "END   $tag  exit=$code  dur=$((SECONDS-start))s  -> $out"
}

log "===================== OPENROUTER SWEEP START ====================="
log "judge=$JUDGE  emb=$EMB  N=$N  topk=$TOPK  data=$DATA  arms=${ARMS[*]}"

# 1) Baseline reference column (four-way), computed ONCE on the cheapest model+arm.
run "${CURVE_MODELS[0]}" "v5" ""

# 2) The canonicalization-tax curve: every curve model × every arm (wanshi-only).
for M in "${CURVE_MODELS[@]}"; do
  for A in "${ARMS[@]}"; do
    # skip the (model[0], v5) cell — already covered by the four-way run above.
    [ "$M" = "${CURVE_MODELS[0]}" ] && [ "$A" = "v5" ] && continue
    run "$M" "$A" "--no-rescore-baselines"
  done
done

# 3) The product arm (v5 + glossary) on the SOTA tier — the headline cells.
if [ "${ONLY_CURVE:-0}" != "1" ]; then
  for M in "${SOTA_MODELS[@]}"; do
    run "$M" "glossary" "--no-rescore-baselines"
  done
fi

log "===================== OPENROUTER SWEEP DONE ====================="
