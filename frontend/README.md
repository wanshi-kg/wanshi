# wanshi frontend

A Next.js (App Router) dashboard to configure a wanshi run, launch it, and watch
**live progress** — file/chunk bars, running entity/relation counts, a live log
tail, and graceful cancel. The design system is ported from `gol-eval`
(shadcn/ui "new-york", Tailwind v4, OKLch tokens) for a consistent look.

## How it works

There is **no separate backend**. Next route handlers under `app/api/runs/`
are the backend: they spawn the wanshi CLI as a child process, parse its
`--progress-ndjson` stdout stream, and re-stream it to the browser over SSE.
`frontend/` never imports wanshi, so none of its native deps touch this build.

- `POST /api/runs` — start a run (writes a temp JSON config, spawns the CLI).
- `GET  /api/runs` · `GET /api/runs/:id` — list / status.
- `GET  /api/runs/:id/stream` — SSE progress + log tail.
- `POST /api/runs/:id/cancel` — `SIGINT` (graceful: finish chunk, flush partial
  graph). A second call force-quits.

## Running it

The dashboard launches the **built** wanshi CLI, so build the repo first:

```bash
# from the repo root
npm run build            # produces dist/index.js (what the dashboard runs)

# then, in this folder
cd frontend
npm install
npm run dev              # http://localhost:3000
```

Ollama (or your configured provider) must be reachable for runs to produce a
graph — same requirement as the CLI.

### Configuration (env)

| Var          | Default                         | Purpose                                            |
| ------------ | ------------------------------- | -------------------------------------------------- |
| `WANSHI_CMD` | `node dist/index.js`            | How to launch the CLI. Single process so one SIGINT reaches its graceful-shutdown handler (an `npx` wrapper would double-signal it into a force-quit). |
| `WANSHI_CWD` | repo root (parent of `frontend/`) | Working directory the CLI runs in.               |

To run from source instead of a build, install `ts-node` in the repo and set
e.g. `WANSHI_CMD="node -r ts-node/register src/index.ts"`.

## Status

Wired today: the **Run → live progress** flow (config form, SSE progress view,
cancel, recent-runs list). `Results`, `Graph`, and `Settings` are scaffolded
placeholders for future work.

## Notes / limitations

- The run registry (`server/run-registry.ts`) is an in-memory, single-process
  store (kept on `globalThis` to survive dev hot-reload). Fine for a local,
  single-user tool; it does not persist across server restarts and assumes one
  Next server owns the spawned children.
