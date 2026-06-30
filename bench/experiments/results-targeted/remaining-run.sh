#!/usr/bin/env bash
# Resilient relaunch of the cells that died (twice) mid-run: cybersec @ code (ctx 8192)
# then medgemma @ biored (ctx 32768). One script = one detached process; launched under
# caffeinate in an orphaning subshell so shell/process-group cleanup can't reap it.
# Writes the cron's DONE sentinel at the end.
set -uo pipefail
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-targeted
echo "[remaining] $(date) START — cybersec@code then medgemma@biored" >> "$RES/run.log"

PAIRS="hf.co/mradermacher/WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M|code hf.co/mradermacher/RedTeamer-v1-GGUF:Q8_0|code" \
  bash "$RES/targeted-run.sh"

PAIRS="medgemma1.5:4b|biored" CTX=32768 MAXTOK=32768 \
  bash "$RES/targeted-run.sh"

echo "[remaining] $(date) ALL DONE" >> "$RES/run.log"
echo "[chain-medgemma] medgemma DONE (remaining-run sentinel)" >> "$RES/run.log"
