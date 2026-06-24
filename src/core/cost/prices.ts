/**
 * Built-in best-effort price map for cost metering. Values are USD per 1M tokens
 * `{ in: prompt, out: completion }`. Matched by exact model id first, then by the
 * longest key that is a substring of the model id (so `gpt-4o` matches
 * `gpt-4o-2024-08-06`, and an OpenRouter `openai/gpt-4o` matches `gpt-4o`).
 *
 * Prices DRIFT. This map is a convenience, not a source of truth — the tally
 * prints `PRICES_AS_OF` and tells the user to override via `cost.prices` for an
 * accurate bill. A model with no match resolves to 0 (local Ollama, or an
 * unknown id) and is reported as `$0` with a one-time note.
 */
export const PRICES_AS_OF = "2026-06";

export interface ModelPrice {
  in: number; // USD per 1M prompt tokens
  out: number; // USD per 1M completion tokens
}

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "o4-mini": { in: 1.1, out: 4.4 },
  // Anthropic. OpenRouter and Anthropic's own ids use DOTTED minor versions
  // (`claude-3.5-sonnet`); the hyphenated keys don't substring-match those, so
  // both spellings are listed (WS-22).
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  "claude-3.5-haiku": { in: 0.8, out: 4 },
  "claude-3-5-sonnet": { in: 3, out: 15 },
  "claude-3.5-sonnet": { in: 3, out: 15 },
  "claude-3-7-sonnet": { in: 3, out: 15 },
  "claude-3.7-sonnet": { in: 3, out: 15 },
  "claude-3-opus": { in: 15, out: 75 },
  // Google (Gemini, incl. OpenRouter ids like `google/gemini-1.5-pro`)
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  // Open-weight on metered hosts (OpenRouter-style ids); rough midpoints
  "llama-3.1-70b": { in: 0.35, out: 0.4 },
  "llama-3.3-70b": { in: 0.35, out: 0.4 },
  "qwen-2.5-72b": { in: 0.35, out: 0.4 },
  // Local Ollama is free; left unlisted ⇒ resolves to 0.
};
