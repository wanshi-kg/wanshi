#!/usr/bin/env bash
# Chain the cybersec-tier code cells AFTER the in-flight targeted run finishes (no GPU
# contention — only 2 models fit resident, so runs must be sequential). Completes the
# code-dataset tier study: generalist (gemma3:4b) vs coder (OmniCoder-9B) vs cybersec
# (WhiteRabbitNeo-V3-7B, RedTeamer-v1).
set -uo pipefail
WAITPID="${1:-73452}"
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-targeted
echo "[chain] $(date) waiting for pid $WAITPID (current targeted run) to finish…" >> "$RES/run.log"
while kill -0 "$WAITPID" 2>/dev/null; do sleep 30; done
echo "[chain] $(date) prior run done → launching cybersec code cells" >> "$RES/run.log"
PAIRS="hf.co/mradermacher/WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M|code hf.co/mradermacher/RedTeamer-v1-GGUF:Q8_0|code" \
  bash "$RES/targeted-run.sh"
echo "[chain] $(date) cybersec tier DONE" >> "$RES/run.log"
