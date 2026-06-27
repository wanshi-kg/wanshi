#!/usr/bin/env bash
# Local-model gold benchmark sweep: wanshi vs KGGen, SAME local Ollama model.
# Loops MODELS × DATASETS × MODES; each cell = the 3-step gold-compare flow
# (wanshi extract + dump samples → KGGen on the same local model → score two-way).
# Resumable (JSONL caches); a cell failure is logged and skipped, never fatal.
#
# Quickest path — pick a PHASE preset (Dove's run plan, 2026-06-27, ordered by value):
#   PHASE=sanity      gemma3:4b · semeval · closed · N=20    pipeline sanity (~minutes)
#   PHASE=calibrate   gemma3:4b · biored  · closed · N=5     TIME one cell, both tools → budget math
#   PHASE=capstone    {gemma3:4b,qwen3:8b} × {biored,drugprot,finred} × {closed,vocab} × N=40
#                     ↑ the must-have: H-L1 (4B invariance) + H-L3 (dense gemma vs qwen) + typed-capability
#   PHASE=gradient    {gemma3:1b,gemma3:4b,gemma3:12b} × biored × {closed,vocab} × N=40   H-L2 gradient
#   PHASE=docarc      {gemma3:4b,qwen3:8b} × redocred × {closed,vocab} × N=30   doc-level precision arc
#   PHASE=continuity  gemma3:4b × crossre × {closed,vocab} × N=20    general-benchmark continuity
# A PHASE preset is authoritative (sets MODELS/DATASETS/MODES/LIMIT). For a custom run, omit
# PHASE and set the four vars directly.
#
# Tunables (env, with defaults):
#   MODELS     "gemma3:4b qwen3:8b"
#   DATASETS   "biored drugprot finred redocred crossre"   (drugprot = a confirmed node-win)
#   MODES      "closed vocab"             vocab applies only where data/<ds>/relations.vocab exists
#   LIMIT      40                         per-dataset sample cap (KGGen collapse is visible at N=30–40)
#   REDOCRED_LIMIT 30                     redocred is doc-level → fewer
#   PERDOMAIN  50                         CrossRE per-domain cap
#   EMB_MODEL  nomic-embed-text           local embeddings (free)
#   CALIBRATE  (set by PHASE=calibrate)   log wanshi + KGGen wall-clock/sample per cell
set -uo pipefail
cd /app

MODELS="${MODELS:-gemma3:4b qwen3:8b}"
DATASETS="${DATASETS:-biored drugprot finred redocred crossre}"
MODES="${MODES:-closed vocab}"
LIMIT="${LIMIT:-40}"
REDOCRED_LIMIT="${REDOCRED_LIMIT:-30}"
PERDOMAIN="${PERDOMAIN:-50}"
EMB_MODEL="${EMB_MODEL:-nomic-embed-text}"
CALIBRATE="${CALIBRATE:-}"

# PHASE presets (authoritative — override the env/defaults above).
case "${PHASE:-}" in
  sanity)        MODELS="gemma3:4b"; DATASETS="semeval"; MODES="closed"; LIMIT=20 ;;
  calibrate)     MODELS="gemma3:4b"; DATASETS="biored"; MODES="closed"; LIMIT=5; CALIBRATE=1 ;;
  1|capstone)    MODELS="gemma3:4b qwen3:8b"; DATASETS="biored drugprot finred"; MODES="closed vocab"; LIMIT=40 ;;
  2|gradient)    MODELS="gemma3:1b gemma3:4b gemma3:12b"; DATASETS="biored"; MODES="closed vocab"; LIMIT=40 ;;
  docarc)        MODELS="gemma3:4b qwen3:8b"; DATASETS="redocred"; MODES="closed vocab"; REDOCRED_LIMIT=30 ;;
  3|continuity)  MODELS="gemma3:4b"; DATASETS="crossre"; MODES="closed vocab"; LIMIT=20 ;;
  ""|default)    ;;  # no preset → env/defaults above
  *)             echo "[bench-run] unknown PHASE='${PHASE}' — using env/defaults" >&2 ;;
esac

OLLAMA_BASE="http://${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_API_BASE="${OLLAMA_BASE}"
PY="${VENV_KGGEN:-/opt/venv-kggen}/bin/python"
RESULTS=/app/results
mkdir -p "${RESULTS}"
LOG="${RESULTS}/sweep.log"

log() { echo "[bench-run] $*" | tee -a "${LOG}"; }
slug() { echo "$1" | tr '/:.' '_'; }

log "PHASE=${PHASE:-none} MODELS=[${MODELS}] DATASETS=[${DATASETS}] MODES=[${MODES}] LIMIT=${LIMIT} (redocred=${REDOCRED_LIMIT})${CALIBRATE:+ CALIBRATE} EMB=${EMB_MODEL}"
log "pulling embeddings model ${EMB_MODEL}…"; ollama pull "${EMB_MODEL}" 2>&1 | tail -1 | tee -a "${LOG}"

run_cell() {
  local model="$1" ds="$2" mode="$3"
  local s; s="$(slug "${model}")"
  local cache="data/${ds}/compare/${s}"   # per-MODEL cache dir (kggen.jsonl isn't model-keyed upstream)
  local lim="${LIMIT}"; [ "${ds}" = "redocred" ] && lim="${REDOCRED_LIMIT}"
  local vocab=()
  if [ "${mode}" = "vocab" ]; then
    [ -f "data/${ds}/relations.vocab" ] || { log "skip ${ds}/vocab (no relations.vocab)"; return 0; }
    vocab=(--relation-vocab "@data/${ds}/relations.vocab")
  fi
  local common=(--dataset "${ds}" --model "${model}" --provider ollama --host "${OLLAMA_BASE}"
                --embeddings-provider ollama --embeddings-model "${EMB_MODEL}" --embeddings-host "${OLLAMA_BASE}"
                --limit "${lim}" --per-domain "${PERDOMAIN}" --cache-dir "${cache}")
  log "=== CELL model=${model} ds=${ds} mode=${mode} N=${lim} → ${cache} ==="

  # 1) wanshi extract + dump samples.jsonl (+ the wanshi.<slug><mode>.stats.json sidecar)
  npx ts-node scripts/gold-compare.ts "${common[@]}" "${vocab[@]}" 2>&1 | tee -a "${LOG}" \
    || { log "gold-compare(extract) FAILED ${model}/${ds}/${mode} — skipping cell"; return 0; }

  # 2) KGGen on the SAME local model (once per model+ds; reused across modes). Timed for calibration.
  #    LiteLLM ollama_chat/ provider → local Ollama; a dummy OPENROUTER_API_KEY satisfies the key check.
  if [ ! -s "${cache}/kggen.jsonl" ]; then
    log "KGGen (ollama_chat/${model}) → ${cache}/kggen.jsonl"
    local k0 k1; k0=$(date +%s)
    OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-ollama}" OLLAMA_API_BASE="${OLLAMA_BASE}" \
      "${PY}" scripts/kggen-crossre.py --model "${model}" --model-prefix "ollama_chat/" \
        --samples "${cache}/samples.jsonl" --out "${cache}/kggen.jsonl" 2>&1 | tee -a "${LOG}" \
      || log "KGGen FAILED ${model}/${ds} — continuing (wanshi-only table)"
    k1=$(date +%s)
    local n; n=$(wc -l < "${cache}/samples.jsonl" 2>/dev/null | tr -d ' '); n=${n:-0}
    [ "${n}" -gt 0 ] && log "TIMING kggen ${model}/${ds}: $((k1-k0))s / ${n} samples = $(awk "BEGIN{printf \"%.1f\", ($k1-$k0)/$n}")s/sample"
  else
    log "KGGen cache present for ${model}/${ds} — reuse"
  fi

  # 3) re-run → two-way table + JSON report (extraction stats reloaded from the step-1 sidecar)
  npx ts-node scripts/gold-compare.ts "${common[@]}" "${vocab[@]}" 2>&1 | tee -a "${LOG}" \
    || log "gold-compare(score) FAILED ${model}/${ds}/${mode}"

  # Calibration: surface wanshi wall-clock/sample (KGGen side is logged above) from the report.
  if [ -n "${CALIBRATE}" ]; then
    local rep="results/${ds}/${s}__${mode}__wanshi-vs-kggen.json"
    if [ -f "${rep}" ]; then
      local wsec wext wtok wconf wps
      wsec=$(jq -r '.extraction.seconds // 0' "${rep}" 2>/dev/null)
      wext=$(jq -r '.extraction.extracted // 0' "${rep}" 2>/dev/null)
      wtok=$(jq -r '.extraction.completionTokensPerSec // "-"' "${rep}" 2>/dev/null)
      wconf=$(jq -r '.extraction.conformanceRate // "-"' "${rep}" 2>/dev/null)
      wps="—"; [ "${wext:-0}" != "0" ] && wps="$(awk "BEGIN{printf \"%.1f\", ${wsec}/${wext}}")"
      log "TIMING wanshi ${model}/${ds}: ${wsec}s / ${wext} samples = ${wps}s/sample · ${wtok} tok/s · conformance ${wconf}"
    fi
  fi
}

for model in ${MODELS}; do
  log "pulling model ${model}…"; ollama pull "${model}" 2>&1 | tail -1 | tee -a "${LOG}"
  for ds in ${DATASETS}; do
    for mode in ${MODES}; do
      run_cell "${model}" "${ds}" "${mode}"
    done
  done
done

# Roll the JSON reports into one scannable table. wNode/kNode = node entity-capture semantic F1
# (the headline); wTri = wanshi endpoint triple F1; conf = JSON-conformance; rel = related_to-share;
# tok/s = wanshi throughput [rental ≠ M4].
log "=== SUMMARY ==="
{
  printf '%-10s %-11s %-7s %7s %7s %7s %6s %6s %7s\n' dataset model mode wNode kNode wTri conf rel tok/s
  find "${RESULTS}" -name '*__*__wanshi-vs-kggen.json' 2>/dev/null | sort | while read -r r; do
    jq -r '[.dataset, .model, .mode,
            (.tools.wanshi.nodeEntityCapture.semantic.f1 // 0),
            (.tools.kggen.nodeEntityCapture.semantic.f1 // "-"),
            (.tools.wanshi.tripletEndpoint.semantic.triple.f1 // 0),
            (.extraction.conformanceRate // "-"),
            (.tools.wanshi.relatedToShare.share // "-"),
            (.extraction.completionTokensPerSec // "-")] | @tsv' "$r" 2>/dev/null \
    | awk -F'\t' '{printf "%-10s %-11s %-7s %7s %7s %7s %6s %6s %7s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}'
  done
} | tee "${RESULTS}/SUMMARY.txt" | tee -a "${LOG}"

log "DONE. JSON reports under ${RESULTS}/<dataset>/ ; summary ${RESULTS}/SUMMARY.txt"
