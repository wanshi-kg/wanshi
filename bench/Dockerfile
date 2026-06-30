# wanshi-bench — local-model gold benchmark (wanshi vs KGGen) served by Ollama.
# Built for linux/amd64 (RunPod L4). FROM ollama/ollama gives Ollama + the CUDA
# runtime libs; we layer Node 20 (the ts-node gold-compare harness) and Python 3
# (KGGen via LiteLLM). Models + corpora are NOT baked here unless the build context
# carries data/ — the entrypoint resolves corpora (baked | tar | mounted) and pulls
# models at run time. Image is fixed/reproducible; the sweep is chosen by env vars.
FROM ollama/ollama:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq zstd \
      python3 python3-venv python3-pip build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first (own cache layer). --omit=dev drops the test/types toolchain (jest, ts-jest,
# @types/*) — the harness runs transpile-only (TS_NODE_TRANSPILE_ONLY below), so type defs aren't
# needed at run time. ts-node (+ typescript) installed globally (separate layer so npm ci stays cached).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npm install -g ts-node typescript && npm cache clean --force

# KGGen (LiteLLM-routed) in an isolated venv so its deps never touch the harness.
RUN python3 -m venv /opt/venv-kggen \
 && /opt/venv-kggen/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv-kggen/bin/pip install --no-cache-dir kg-gen

# Harness + corpora. data/ may be empty (data-free image) — the entrypoint then
# expects a mounted volume or an uploaded corpora tarball at run time.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY bench ./bench
COPY data ./data
RUN chmod +x bench/entrypoint.sh scripts/bench-run.sh scripts/targeted-run.sh scripts/vanilla-run.sh

ENV VENV_KGGEN=/opt/venv-kggen \
    TS_NODE_TRANSPILE_ONLY=1 \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_API_BASE=http://127.0.0.1:11434 \
    OLLAMA_MAX_LOADED_MODELS=2 \
    OLLAMA_KEEP_ALIVE=30m \
    OLLAMA_NUM_PARALLEL=1

# Override ollama/ollama's ENTRYPOINT (/bin/ollama): our script starts the server
# itself, then runs the sweep.
ENTRYPOINT ["/app/bench/entrypoint.sh"]
