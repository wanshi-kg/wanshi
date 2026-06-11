import OpenAI from "openai";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Logger } from "../../shared";
import { parseJsonLenient } from "../../shared/utils";
import { ILLMProvider, LLMOptions, LLMMessage } from "../../types/ILLMProvider";

/**
 * LLM provider for any OpenAI-compatible chat-completions endpoint
 * (OpenAI, OpenRouter, Together, local vLLM, Ollama's OpenAI shim, ...).
 *
 * `options.host` is used as the base URL and `options.apiKey` as the bearer
 * token. Structured output is requested via `response_format: json_schema`,
 * with a graceful fallback to `json_object` + schema-in-prompt for providers
 * or models (e.g. some Gemma deployments) that reject json_schema.
 */
export class OpenAICompatibleService implements ILLMProvider {
  private options: LLMOptions;
  private logger: Logger;
  private client: OpenAI;
  // Flips to false for the rest of the process once a provider rejects json_schema.
  private useJsonSchema = true;

  constructor(options: LLMOptions, logger: Logger) {
    this.logger = logger;
    this.options = {
      temperature: 0.1,
      contextLength: 8192,
      ...options,
    };
    this.client = new OpenAI({
      apiKey: this.options.apiKey || "not-needed",
      baseURL: this.options.host,
    });
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    retries: number = 3
  ): Promise<T> {
    const jsonSchema = this.toPlainJsonSchema(schema);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        this.logger.debug(
          `Generating structured output (attempt ${attempt + 1}/${retries}, ` +
            `mode=${this.useJsonSchema ? "json_schema" : "json_object"})`
        );

        const completion = await this.client.chat.completions.create({
          model: this.options.model,
          messages: this.toOpenAIMessages(messages, jsonSchema),
          temperature: Number(this.options.temperature ?? 0.1),
          ...(this.options.maxTokens
            ? { max_tokens: Number(this.options.maxTokens) }
            : {}),
          response_format: this.useJsonSchema
            ? {
                type: "json_schema",
                json_schema: {
                  name: "knowledge_graph",
                  schema: jsonSchema,
                  strict: false,
                },
              }
            : { type: "json_object" },
        });

        this.logUsage(completion);

        // A "length" finish means the model ran out of output budget and the
        // JSON is truncated — surface an actionable hint instead of a cryptic
        // SyntaxError on the partial body.
        if (completion.choices[0]?.finish_reason === "length") {
          this.logger.warn(
            "LLM output was truncated at the max output-token limit — the JSON is incomplete. " +
              "Increase --max-tokens or reduce --chunk-size."
          );
        }

        const responseContent = (
          completion.choices[0]?.message?.content || ""
        ).trim();
        this.logger.debug(
          `Raw LLM response: ${responseContent.substring(0, 200)}...`
        );

        const parsed = parseJsonLenient(this.stripCodeFence(responseContent), () =>
          this.logger.warn("Response JSON was malformed; recovered with jsonrepair")
        );
        return schema.parse(parsed);
      } catch (error) {
        this.logger.error(
          `LLM generation attempt ${attempt + 1} failed: ${error}`
        );

        // Degrade to json_object if the provider/model rejects json_schema.
        if (this.useJsonSchema && this.isResponseFormatError(error)) {
          this.logger.warn(
            "Provider rejected json_schema response_format; falling back to json_object."
          );
          this.useJsonSchema = false;
        }

        if (attempt === retries - 1) {
          throw new Error(
            `Failed to generate valid output after ${retries} attempts: ${error}`
          );
        }

        await this.delay(1000 * (attempt + 1));
      }
    }

    throw new Error("Should not reach here");
  }

  /**
   * OpenAI-compatible endpoints have no model-introspection equivalent of
   * Ollama's `show`. Vision support cannot be probed, so report none and let
   * the caller decide whether to attach images.
   */
  async getModelCapabilities(_modelName: string): Promise<string[]> {
    return [];
  }

  private toOpenAIMessages(
    messages: LLMMessage[],
    jsonSchema: Record<string, unknown>
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      // In json_object mode the schema must travel in the prompt itself.
      const content =
        !this.useJsonSchema && msg.role === "system"
          ? `${msg.content}\n\nRespond ONLY with JSON matching this JSON schema:\n${JSON.stringify(
              jsonSchema
            )}`
          : msg.content;

      const hasImages =
        this.options.images && msg.images && msg.images.length > 0;

      if (hasImages && msg.role === "user") {
        return {
          role: "user",
          content: [
            { type: "text", text: content },
            ...msg.images!.map((b64) => ({
              type: "image_url" as const,
              image_url: { url: `data:image/png;base64,${b64}` },
            })),
          ],
        };
      }

      return { role: msg.role, content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    });
  }

  private toPlainJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
    const json = zodToJsonSchema(schema) as Record<string, unknown>;
    // OpenAI's json_schema does not want the meta $schema key.
    delete json["$schema"];
    return json;
  }

  private stripCodeFence(content: string): string {
    if (content.startsWith("```")) {
      return content.slice(
        content.indexOf("\n") + 1,
        content.lastIndexOf("\n")
      );
    }
    return content;
  }

  private isResponseFormatError(error: unknown): boolean {
    const status = (error as { status?: number })?.status;
    const message = String((error as { message?: string })?.message ?? error);
    return (
      status === 400 ||
      /response_format|json_schema|schema|not supported|unsupported/i.test(
        message
      )
    );
  }

  private logUsage(completion: OpenAI.Chat.Completions.ChatCompletion): void {
    if (completion.usage) {
      this.logger.info(
        `LLM stats: ${JSON.stringify({
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
          total_tokens: completion.usage.total_tokens,
        })}`
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
