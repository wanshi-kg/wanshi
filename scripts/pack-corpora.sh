#!/usr/bin/env bash
# Pack the gold corpora (EXCLUDING the 11GB REBEL, which is not a gold set) into a
# single corpora.tar.zst for the private data repo or a direct pod upload.
# Run from the bench repo root (where data/ lives). ~80MB output.
set -euo pipefail
OUT="${1:-corpora.tar.zst}"
SETS="crossre semeval redocred biored scier drugprot finred code mine"
args=()
for d in ${SETS}; do
  if [ -e "data/${d}" ]; then args+=("data/${d}"); else echo "warn: data/${d} missing, skipping" >&2; fi
done
[ ${#args[@]} -gt 0 ] || { echo "no corpora found under data/"; exit 1; }
echo "packing: ${args[*]}"
# Pipe tar → zstd (portable): `tar -I 'zstd -19 -T0'` is a GNU-tar-ism that macOS bsdtar
# parses as a literal program name "zstd -19 -T0" and fails. pipefail catches a tar error.
tar --no-xattrs -cf - "${args[@]}" | zstd -19 -T0 -o "${OUT}" -f
ls -lh "${OUT}"
echo "done → ${OUT}"
echo "extract: zstd -dc ${OUT} | tar -xf - -C <dest>   (yields data/<set>/…)"
