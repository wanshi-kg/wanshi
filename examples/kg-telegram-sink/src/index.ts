import { loadConfig } from "./config";
import { Bot } from "./telegram/Bot";
import { SourceRouter } from "./ingest/SourceRouter";
import { IngestContext, IngestedItem } from "./ingest/types";
import { Pipeline, RebuildResult } from "./kg/Pipeline";

const DEBOUNCE_MS = 3000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function summarizeIngest(items: IngestedItem[]): string {
  if (items.length === 0) return "Hmm, I couldn't make anything of that.";
  const kinds = items.map((i) => i.kind).join(", ");
  const notes = items.map((i) => i.note).filter(Boolean);
  const head = `Saved ${items.length} item(s) [${kinds}] — extracting…`;
  return notes.length ? `${head}\n⚠️ ${notes.join("\n⚠️ ")}` : head;
}

function summarizeRebuild(r: RebuildResult): string {
  const d = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return (
    `✅ Graph updated — ${r.after.entities} entities / ${r.after.relations} relations ` +
    `(${d(r.delta.entities)} / ${d(r.delta.relations)})`
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log(`inbox: ${cfg.inboxDir}`);
  log(`output (mcp-jsonl): ${cfg.outputPath}`);
  log(`generation: ${cfg.options.llm.provider} (${cfg.options.llm.model})`);

  const bot = new Bot(cfg.env.botToken, cfg.env.allowedUserIds, cfg.inboxDir, log);
  const router = new SourceRouter();

  const pipeline = new Pipeline(
    cfg.options,
    DEBOUNCE_MS,
    (result, chatIds) => {
      const text = summarizeRebuild(result);
      for (const id of chatIds) void bot.send(id, text);
    },
    (err, chatIds) => {
      const text = `❌ Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
      for (const id of chatIds) void bot.send(id, text);
    },
    log
  );
  await pipeline.init();

  bot.start(async (msg) => {
    const ctx: IngestContext = {
      inboxDir: cfg.inboxDir,
      downloadFile: bot.downloadFile,
      log,
    };
    const items = await router.route(msg, ctx);
    await bot.send(msg.chatId, summarizeIngest(items));
    if (items.length > 0) pipeline.requestRebuild(msg.chatId);
  });

  log("ready — forward content to the bot.");
}

main().catch((err) => {
  log(`fatal: ${err}`);
  process.exit(1);
});
