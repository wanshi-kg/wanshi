import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import * as dotenv from "dotenv";
import { parseConfig, ProcessingOptions } from "kg-gen/src/config";

dotenv.config();

const ROOT = path.resolve(__dirname, "..");

export interface BotEnv {
  botToken: string;
  allowedUserIds: number[];
}

export interface AppConfig {
  options: ProcessingOptions; // fully-resolved kg-gen config (nested + defaults)
  env: BotEnv;
  inboxDir: string; // absolute
  outputPath: string; // absolute
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

export function loadConfig(): AppConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set (copy .env.example to .env and fill it in)");
  }

  const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  const configPath = resolveFromRoot(process.env.KG_CONFIG_PATH ?? "config.yaml");
  const raw = YAML.parse(fs.readFileSync(configPath, "utf-8"));

  // Resolve the bot-managed paths to absolute so the run is cwd-independent.
  raw.input = resolveFromRoot(raw.input);
  raw.output = resolveFromRoot(raw.output);

  // API keys may come from the environment instead of config.yaml. kg-gen's CLI
  // does this env→config injection itself; calling parseConfig directly bypasses
  // it, so we replicate it here (otherwise the OpenAI provider gets "not-needed").
  const envApiKey = process.env.OPENAI_API_KEY || process.env.KG_API_KEY;
  if (envApiKey) {
    raw.llm = { ...(raw.llm ?? {}) };
    raw.embeddings = { ...(raw.embeddings ?? {}) };
    if (!raw.llm.apiKey) raw.llm.apiKey = envApiKey;
    if (!raw.embeddings.apiKey) raw.embeddings.apiKey = envApiKey;
  }

  const options = parseConfig(raw);

  fs.mkdirSync(options.input, { recursive: true });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });

  return {
    options,
    env: { botToken, allowedUserIds },
    inboxDir: options.input,
    outputPath: options.output,
  };
}
