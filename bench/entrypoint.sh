#!/usr/bin/env bash
# Container entrypoint: resolve corpora → start Ollama → run the sweep.
# Corpora delivery is flexible (the bake-vs-upload choice stays reversible):
#   1. baked   — data/ already populated in the image (private image)
#   2. tar     — CORPORA_TAR=/path/to/corpora.tar.zst  (uploaded to the pod)
#   3. mount   — CORPORA_DIR=/data  (a RunPod volume holding the data/ tree)
set -uo pipefail
APP=/app
cd "$APP"

have_corpora() { [ -f data/semeval/test.jsonl ] || [ -d data/crossre/crossre_data ] || [ -f data/finred/test.jsonl ]; }

echo "[entrypoint] resolving corpora…"
if have_corpora; then
  echo "[entrypoint] corpora present (baked)"
elif [ -n "${CORPORA_TAR:-}" ] && [ -f "${CORPORA_TAR}" ]; then
  echo "[entrypoint] extracting ${CORPORA_TAR} → ${APP}"
  tar -I zstd -xf "${CORPORA_TAR}" -C "${APP}" || tar -xf "${CORPORA_TAR}" -C "${APP}"
elif [ -d "${CORPORA_DIR:-/data}" ] && [ -n "$(ls -A "${CORPORA_DIR:-/data}" 2>/dev/null)" ]; then
  src="${CORPORA_DIR:-/data}"
  echo "[entrypoint] linking corpora from ${src}"
  rm -rf "${APP}/data" && ln -s "${src}" "${APP}/data"
fi
have_corpora || echo "[entrypoint] WARNING: no corpora resolved — dataset loads will fail." >&2

echo "[entrypoint] starting ollama (OLLAMA_HOST=${OLLAMA_HOST}, MAX_LOADED=${OLLAMA_MAX_LOADED_MODELS}, KEEP_ALIVE=${OLLAMA_KEEP_ALIVE})…"
ollama serve >/var/log/ollama.log 2>&1 &
base="http://${OLLAMA_HOST}"
for i in $(seq 1 60); do
  curl -fsS "${base}/api/version" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "[entrypoint] ollama did not come up; tail of log:" >&2; tail -20 /var/log/ollama.log >&2; exit 1; }
  sleep 1
done
echo "[entrypoint] ollama up: $(curl -fsS "${base}/api/version")"

# Self-terminate after the sweep so an idle GPU pod doesn't burn credits (the
# budget guard). RunPod injects a pre-authenticated, pod-scoped runpodctl + the
# $RUNPOD_POD_ID env into every pod (custom images included), so no API key is
# needed. Controlled by SELF_TERMINATE:
#   stop   (default) — halt GPU billing, KEEP the pod + its disk so you can
#                      restart briefly and pull /app/results. Safe default.
#   remove           — delete the pod entirely. Use ONLY when /app/results is on
#                      a network volume (results survive); stops ALL billing.
#   off              — leave the pod running (local/debug).
# Fires on EVERY exit (success, cell failure, or crash) via the EXIT trap; the
# sweep is resumable, so even an accidental restart re-reaches the end and stops.
self_terminate() {
  local rc=$?
  local mode="${SELF_TERMINATE:-stop}"
  if [ "${mode}" = "off" ]; then echo "[entrypoint] SELF_TERMINATE=off — pod left running (rc=${rc})"; return 0; fi
  local pid="${RUNPOD_POD_ID:-}"
  if [ -z "${pid}" ]; then echo "[entrypoint] no \$RUNPOD_POD_ID (not a RunPod pod?) — skip self-terminate (rc=${rc})"; return 0; fi
  if ! command -v runpodctl >/dev/null 2>&1; then
    echo "[entrypoint] runpodctl not found — installing (fallback)…"
    curl -fsSL cli.runpod.net | bash >/dev/null 2>&1 || true
  fi
  if ! command -v runpodctl >/dev/null 2>&1; then
    echo "[entrypoint] WARNING: runpodctl unavailable — STOP/REMOVE pod ${pid} MANUALLY to stop billing! (rc=${rc})" >&2
    return 0
  fi
  echo "[entrypoint] sweep finished (rc=${rc}); self-${mode} pod ${pid} to stop billing…"
  case "${mode}" in
    remove) runpodctl remove pod "${pid}" 2>/dev/null || runpodctl pod delete "${pid}" 2>/dev/null || true ;;
    *)      runpodctl stop   pod "${pid}" 2>/dev/null || runpodctl pod stop   "${pid}" 2>/dev/null || true ;;
  esac
}
trap self_terminate EXIT

echo "[entrypoint] starting sweep (SELF_TERMINATE=${SELF_TERMINATE:-stop} on completion)…"
"${APP}/scripts/bench-run.sh"
