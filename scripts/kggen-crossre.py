#!/usr/bin/env python3
"""
KGGen extractor for the CrossRE two-way comparison (wanshi vs KGGen, same model).

CrossRE ships NO pre-stored baseline graphs (unlike the MINE HF mirror), so we run
KGGen ourselves and cache its per-sentence graphs to disk; the TS scorer
(scripts/crossre-compare.ts) then re-scores them with the SAME matchers it uses for
wanshi. Both tools read the SAME dumped sample list (data/crossre/compare/samples.jsonl,
written by crossre-compare.ts) — the explicit guard against the input↔graph desync that
poisoned the MINE mirror.

Setup (one-time; venv is gitignored):
    python3 -m venv .venv-kggen
    .venv-kggen/bin/pip install kg-gen
    .venv-kggen/bin/python scripts/kggen-crossre.py --model deepseek/deepseek-v4-pro

Routing: KGGen goes through LiteLLM. We prefix the model with `openrouter/` and pass the
OpenRouter key (OPENROUTER_API_KEY, else OPENAI_API_KEY from the repo .env — which holds
the sk-or-... key). Output shape matches KGGen's Graph and MineDataset.toGraph:
    {"id": "<doc_key>", "graph": {"entities": [...], "edges": [...], "relations": [[s,p,o],...]}}

Resumable: ids already in the output JSONL are skipped. A generate() exception is treated
as a transient failure (NOT recorded) so a re-run retries it — mirroring BenchmarkRunner's
"failed extraction excluded from metrics, not scored 0" rule. An empty-but-successful graph
IS recorded (a real low-coverage signal, scored as-is).
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_dotenv() -> None:
    """Populate os.environ from the repo .env (no python-dotenv dep)."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", line)
        if not m:
            continue
        val = m.group(2).strip()
        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
            val = val[1:-1]
        os.environ.setdefault(m.group(1), val)


def serialize_graph(graph) -> dict:
    """KGGen Graph -> {entities, edges, relations} (sets -> sorted lists, tuples -> lists)."""
    def as_list(x):
        return sorted(x) if isinstance(x, (set, frozenset)) else list(x)
    return {
        "entities": as_list(getattr(graph, "entities", []) or []),
        "edges": as_list(getattr(graph, "edges", []) or []),
        "relations": [list(r) for r in (getattr(graph, "relations", []) or [])],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Run KGGen over the CrossRE sample list and cache its graphs.")
    ap.add_argument("--model", required=True, help="Model id without provider prefix, e.g. deepseek/deepseek-v4-pro")
    ap.add_argument("--model-prefix", default="openrouter/", help="LiteLLM provider prefix (default: openrouter/)")
    ap.add_argument("--samples", default=str(ROOT / "data/crossre/compare/samples.jsonl"),
                    help="Sample list dumped by crossre-compare.ts")
    ap.add_argument("--out", default=str(ROOT / "data/crossre/compare/kggen.jsonl"),
                    help="Output JSONL cache of KGGen graphs")
    ap.add_argument("--limit", type=int, default=0, help="Max samples (0 = all)")
    ap.add_argument("--temperature", type=float, default=0.0)
    args = ap.parse_args()

    load_dotenv()
    api_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        sys.exit("No API key: set OPENROUTER_API_KEY or OPENAI_API_KEY (repo .env).")
    # LiteLLM reads OPENROUTER_API_KEY from env for the openrouter/ provider.
    os.environ.setdefault("OPENROUTER_API_KEY", api_key)

    samples_path = Path(args.samples)
    if not samples_path.exists():
        sys.exit(f"Sample list not found: {samples_path}\nRun scripts/crossre-compare.ts first to dump it.")

    samples = []
    for line in samples_path.read_text().splitlines():
        line = line.strip()
        if line:
            samples.append(json.loads(line))
    if args.limit > 0:
        samples = samples[: args.limit]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    done = set()
    if out_path.exists():
        for line in out_path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["id"])
            except (json.JSONDecodeError, KeyError):
                continue  # tolerate a truncated final line from an interrupted write
    print(f"[kggen-crossre] {len(samples)} samples, {len(done)} already cached -> {out_path}", flush=True)

    # Lazy import so --help / arg errors don't require the package installed.
    from kg_gen import KGGen
    model = args.model if args.model.startswith(args.model_prefix) else f"{args.model_prefix}{args.model}"
    # kg-gen hard-requires temperature 1.0 for the gpt-5 family (and the reasoning
    # models ignore <1.0 anyway). Force it so a temp-0 default doesn't abort the run.
    temperature = args.temperature
    if "gpt-5" in model and temperature != 1.0:
        print(f"[kggen-crossre] gpt-5 family requires temperature=1.0 — overriding {temperature}", flush=True)
        temperature = 1.0
    kg = KGGen(model=model, api_key=api_key, temperature=temperature)
    print(f"[kggen-crossre] model={model} temp={temperature}", flush=True)

    todo = [s for s in samples if s["id"] not in done]
    ok = fail = 0
    with out_path.open("a", encoding="utf-8") as f:
        for i, s in enumerate(todo, 1):
            sid, text = s["id"], s["text"]
            try:
                graph = kg.generate(input_data=text)
                rec = {"id": sid, "graph": serialize_graph(graph)}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                f.flush()
                ok += 1
            except Exception as e:  # transient -> skip (not recorded), retried on re-run
                fail += 1
                print(f"[kggen-crossre] FAIL {sid}: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            if i % 10 == 0 or i == len(todo):
                print(f"[kggen-crossre] {i}/{len(todo)} (ok={ok} fail={fail})", flush=True)

    print(f"[kggen-crossre] DONE ok={ok} fail={fail} total_cached={len(done)+ok}", flush=True)


if __name__ == "__main__":
    main()
