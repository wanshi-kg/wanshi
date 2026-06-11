# kg-telegram-sink

A Telegram bot you use as a **personal content sink**: forward it articles, videos,
posts, files or contacts, and it continuously folds them into a **knowledge graph in
`mcp-jsonl`** that you wire into **Claude Desktop's memory MCP server** — so you can
watch, live, what kg-gen extracts well and badly.

## How it works

```
Telegram msg ─► SourceRouter (first-match handler) ─► writes a file into data/inbox/
                                                          │
                                                          ▼  (debounced, single-flight)
        kg-gen DirectoryProcessor.processDirectory(resume:true)
        discover inbox → extract NEW files only → merge / dedup / canonicalize → export
                                                          │
                                                          ▼
                            data/output/graph.mcp-jsonl  (complete graph, overwritten)
                                                          │
                                                          ▼
                  Claude Desktop memory server  (reads the file fresh on every call)
```

The trick: we don't reimplement merging. Each new item becomes a file in `data/inbox/`,
then we re-run kg-gen's whole pipeline. `resume: true` restores already-extracted chunks
from a checkpoint sidecar (no re-billing the LLM), re-merges everything, and re-exports
the **complete** graph. Claude Desktop's memory server re-reads its file on every tool
call, so the overwrite shows up with no restart.

## Setup

```bash
cd examples/kg-telegram-sink
npm install
cp .env.example .env      # fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, OPENAI_API_KEY
```

- **Bot token:** create a bot with [@BotFather](https://t.me/BotFather).
- **Your user id:** ask [@userinfobot](https://t.me/userinfobot); put it in
  `TELEGRAM_ALLOWED_USER_IDS` (comma-separated for several people).
- **Generation:** `config.yaml` defaults to an OpenAI-compatible cloud endpoint
  (OpenRouter). Set `llm.host`/`llm.model`; the API key comes from `OPENAI_API_KEY`
  (or `KG_API_KEY`) in `.env`. To run fully local instead, set `llm.provider: ollama`
  and `llm.host: http://localhost:11434`.
- **Embeddings stay local & free** via Ollama (`mxbai-embed-large:335m`) — used for
  dedup/merge/retrieval. Make sure Ollama is running (`ollama list`).

```bash
npm start                 # long-polls Telegram; logs "bot listening"
```

Then forward something. You'll get an immediate `Saved … — extracting…` ack, and an
`✅ Graph updated — N entities / M relations (+Δ)` once the rebuild finishes.

## Wire it into Claude Desktop

Add the official memory server, pointed at this bot's output file, to
`claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "kg-sink-memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/Volumes/2TB/repos/kg-gen/examples/kg-telegram-sink/data/output/graph.mcp-jsonl"
      }
    }
  }
}
```

Restart Claude Desktop, then ask it to read the knowledge graph. Send the bot more
content and ask again — new entities appear without restarting Desktop.

> Treat the file as **kg-gen-owned / read-mostly** in Claude. If Claude *writes*
> memories into it, the next rebuild overwrites them. That's fine for a "watch what
> extraction does" showcase.

## Supported sources

The ingest layer is an extensible **first-match-wins handler registry** (`src/ingest/`),
the same idiom as kg-gen's `FileReaderFactory`.

| Source | Status | Notes |
| --- | --- | --- |
| Web articles (any URL) | ✅ full | Readability-style extraction (`@extractus/article-extractor`); falls back to saving the link |
| YouTube videos | ✅ full | Caption transcript + title/author; says so when captions are missing |
| Plain / forwarded text | ✅ full | Saved verbatim |
| Contacts | ✅ full | Name + phone → person record |
| PDF / Office docs | ✅ full | Downloaded; handled by kg-gen's `PdfReader`/`OfficeReader` |
| Photos / audio | ⚙️ needs models | Downloaded; need Ollama vision / whisper on the kg-gen side |
| **TikTok videos** | 🚧 metadata only | Transcript needs video download + ASR (ffmpeg → whisper) |
| **Generic / TG video** | 🚧 metadata only | Same ASR path; kg-gen has no video reader yet |
| **Channel links** (YT/TikTok) | 🚧 metadata only | Auto-following new uploads is a separate subscription/scheduler feature |

Stub handlers still save *something* (metadata) so the graph isn't empty, and the bot
tells you what was — and wasn't — captured.

### Add a new source

1. Implement `SourceHandler` (`src/ingest/types.ts`) in `src/ingest/handlers/`.
2. Register it at the right priority in `src/ingest/SourceRouter.ts`.

## Caveats (it's a POC)

- **Re-merges the whole inbox each run** — O(n²)-ish over all entities. Fine for a
  personal sink (hundreds of items); not built for tens of thousands.
- Cloud generation is metered; embeddings are local/free. Secrets live in `.env`
  (gitignored), never in `config.yaml`.
- The checkpoint sidecar (`data/output/graph.mcp-jsonl.checkpoint.jsonl`) is what makes
  re-runs cheap; deleting it forces a full re-extraction.
