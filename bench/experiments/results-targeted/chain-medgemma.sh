#!/usr/bin/env bash
# Run medgemma@biored AFTER the code-tier study (pid $1), with a ctx/max-tokens bump —
# medgemma1.5:4b over-generates (eval_count 6603 → truncates at 8192), so give it room
# (the RWKV lesson). Deferred to last so its slowness can't block the code-tier study.
set -uo pipefail
WAITPID="${1:-74442}"
RES=/Volumes/2TB/wanshi-kg/wanshi-bench/results-targeted
echo "[chain-medgemma] $(date) waiting for code-tier run pid $WAITPID…" >> "$RES/run.log"
while kill -0 "$WAITPID" 2>/dev/null; do sleep 30; done
echo "[chain-medgemma] $(date) code-tier done → medgemma@biored (CTX=32768)" >> "$RES/run.log"
PAIRS="medgemma1.5:4b|biored" CTX=32768 MAXTOK=32768 bash "$RES/targeted-run.sh"
echo "[chain-medgemma] $(date) medgemma DONE" >> "$RES/run.log"
