import { Ollama, ChatResponse, ChatRequest, Message } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Logger } from "../../shared";
import { parseJsonLenient } from "../../shared/utils";
import { ILLMProvider, LLMOptions, LLMMessage } from "../../types/ILLMProvider";

// Re-export for back-compat: these types used to live here.
export { LLMOptions, LLMMessage };

/**
 * Service for interacting with Ollama LLMs
 */
export class OllamaService implements ILLMProvider {
  private options: LLMOptions;
  private logger: Logger;
  private ollama: Ollama;

  constructor(options: LLMOptions, logger: Logger) {
    this.logger = logger;
    this.options = {
      temperature: 0.1,
      contextLength: 8192,
      repeatPenalty: 1.1,
      ...options,
    };
    this.ollama = new Ollama({ host: this.options.host });
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

  /**
   * Generate a completion with structured output
   */
  async generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    retries: number = 3
  ): Promise<T> {
    const jsonSchema = zodToJsonSchema(schema);
    // Convert our messages to Ollama format
    const ollamaMessages = await this.toOllamaMessages(messages);

    // Ollama options
    const chatRequest = {
      model: this.options.model,
      messages: ollamaMessages,
      format: jsonSchema,
      think: false,
      options: {
        num_ctx: Number(this.options.contextLength || 8192),
        ...(this.options.maxTokens
          ? { num_predict: Number(this.options.maxTokens) }
          : {}),
        temperature: Number(this.options.temperature),
        repeat_penalty: Number(this.options.repeatPenalty),
        // seed only when set, so an unseeded run keeps Ollama's default RNG.
        ...(this.options.seed !== undefined
          ? { seed: Number(this.options.seed) }
          : {}),
      },
    };

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        this.logger.debug(
          `Generating structured output (attempt ${attempt + 1}/${retries})`
        );

        const response = await this.ollama.chat(chatRequest);

        this.logResponseStats(response);

        // A "length" done_reason means output hit num_predict / the model's
        // limit and the JSON is truncated — give an actionable hint.
        if ((response as { done_reason?: string }).done_reason === "length") {
          this.logger.warn(
            "LLM output was truncated at the output-token limit — the JSON is incomplete. " +
              "Increase --max-tokens or reduce --chunk-size."
          );
        }

        // Parse the response
        const responseContent = response.message.content.trim();
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

        if (attempt === retries - 1) {
          throw new Error(
            `Failed to generate valid output after ${retries} attempts: ${error}`
          );
        }

        // Wait before retry
        await this.delay(1000 * (attempt + 1));
      }
    }

    throw new Error("Should not reach here");
  }

  private async toOllamaMessages(messages: LLMMessage[]): Promise<Message[]> {
    const modelCaps = await this.getModelCapabilities(this.options.model);
    const supportsVision = modelCaps.includes("vision");

    if (this.options.images && !supportsVision) {
      this.logger.warn("Model does not supports vision. Skipping images.");
    }

    const images = this.options.images && supportsVision;

    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      ...(images && msg.images && { images: msg.images }),
    }));

    return ollamaMessages;
  }

  async getModelCapabilities(modelName: string): Promise<string[]> {
    const modelInfo = await this.ollama.show({ model: modelName });
    return modelInfo.capabilities;
  }

  /**
   * Check if a model is available
   */
  async isModelAvailable(modelName: string): Promise<boolean> {
    try {
      const models = await this.ollama.list();
      return models.models.some((m) => m.name === modelName);
    } catch (error) {
      this.logger.error(`Failed to check model availability: ${error}`);
      return false;
    }
  }

  /**
   * Log response statistics
   */
  private logResponseStats(response: ChatResponse): void {
    const stats = {
      eval_count: response.eval_count,
      prompt_eval_count: response.prompt_eval_count,
      total_duration_ms: response.total_duration / 1000000,
      eval_speed_tps:
        (60000000 * (response.prompt_eval_count + response.eval_count)) /
        response.total_duration,
    };

    this.logger.info(`LLM stats: ${JSON.stringify(stats)}`);
  }

  /**
   * Simple delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
