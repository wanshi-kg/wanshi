import { z } from "zod";

/**
 * Provider-agnostic LLM configuration.
 *
 * `host` doubles as the base URL: the Ollama host for the local provider, or
 * the OpenAI-compatible base URL (e.g. https://openrouter.ai/api/v1) for the
 * `openai` provider. `apiKey` is only used by API-based providers.
 */
export interface LLMOptions {
  model: string;
  host: string;
  images: boolean;
  temperature?: number;
  contextLength?: number;
  repeatPenalty?: number;
  seed?: number;
  apiKey?: string;
  /** Max output tokens per generation. Raise it (or lower chunk size) if the
   * model truncates large knowledge-graph JSON mid-output. Unset = provider default. */
  maxTokens?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // Base64 encoded images
}

/** Token usage of the most recent generation (normalized across providers). */
export interface LLMUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Common surface for any LLM backend used by the knowledge-graph builder.
 * Implemented by OllamaService (local) and OpenAICompatibleService (cloud).
 */
export interface ILLMProvider {
  /**
   * Generate a completion constrained to the given Zod schema, retrying on
   * transient/parse failures.
   */
  generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    retries?: number
  ): Promise<T>;

  /**
   * Report model capabilities (e.g. "vision"). API providers without an
   * introspection endpoint may return an empty list.
   */
  getModelCapabilities(model: string): Promise<string[]>;

  /**
   * Token usage of the most recent `generateStructured` call, when the provider
   * exposed it (both providers already log it). Optional — the cost-meter / trace
   * seam reads this right after a call; absent ⇒ usage unknown. Observe-only.
   */
  getLastUsage?(): LLMUsage | undefined;
}
