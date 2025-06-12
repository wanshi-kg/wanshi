import ollama, { ChatResponse, ChatRequest } from "ollama";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { llmLogger, logger } from "../../shared/logger";

export interface LLMOptions {
  model: string;
  host: string;
  temperature?: number;
  contextLength?: number;
  repeatPenalty?: number;
  seed?: number;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[]; // Base64 encoded images
}

/**
 * Service for interacting with Ollama LLMs
 */
export class OllamaService {
  private options: LLMOptions;

  constructor(options: LLMOptions) {
    this.options = {
      temperature: 0.1,
      contextLength: 8192,
      repeatPenalty: 0.3,
      ...options,
    };
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
    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      ...(msg.images && { images: msg.images }),
    }));

    // Ollama options
    const chatRequest = {
      model: this.options.model,
      messages: ollamaMessages,
      format: jsonSchema,
      think: false,
      options: {
        num_ctx: Number(this.options.contextLength || 8192),
        // temperature: 0.1,
        // repeat_penalty: 0.5,
        // temperature: Number(this.options.temperature),
        // repeat_penalty: Number(this.options.repeatPenalty),
        // seed: Number(this.options.seed),
      },
    };

    // llmLogger.info(`Request options`, { ...chatRequest, messages: undefined });

    // ollamaMessages.forEach((m) => llmLogger.info(m));

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logger.debug(
          `Generating structured output (attempt ${attempt + 1}/${retries})`
        );

        const response = await ollama.chat(chatRequest);

        this.logResponseStats(response);

        // Parse the response
        const responseContent = response.message.content.trim();
        logger.debug(
          `Raw LLM response: ${responseContent.substring(0, 200)}...`
        );

        // Handle code block wrapped responses
        let cleanContent = responseContent;
        if (cleanContent.startsWith("```")) {
          cleanContent = cleanContent.slice(
            cleanContent.indexOf("\n") + 1,
            cleanContent.lastIndexOf("\n")
          );
        }

        const parsed = JSON.parse(cleanContent);

        // Validate against schema
        const validated = schema.parse(parsed);
        return validated;
      } catch (error) {
        logger.error(`LLM generation attempt ${attempt + 1} failed: ${error}`);

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

  /**
   * Generate a simple text completion
   */
  async generate(messages: LLMMessage[]): Promise<string> {
    logger.debug(`Generating text completion`);

    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      ...(msg.images && { images: msg.images }),
    }));

    const response = await ollama.chat({
      model: this.options.model,
      messages: ollamaMessages,
      options: {
        temperature: this.options.temperature,
        num_ctx: this.options.contextLength,
        repeat_penalty: this.options.repeatPenalty,
        ...(this.options.seed && { seed: this.options.seed }),
      },
    });

    this.logResponseStats(response);
    return response.message.content;
  }

  /**
   * Generate embeddings for text
   */
  async generateEmbeddings(text: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(text) ? text : [text];
    logger.debug(`Generating embeddings for ${texts.length} texts`);

    const embeddings: number[][] = [];

    for (const t of texts) {
      const response = await ollama.embeddings({
        model: this.options.model,
        prompt: t,
      });
      embeddings.push(response.embedding);
    }

    return embeddings;
  }

  /**
   * Check if a model is available
   */
  async isModelAvailable(modelName: string): Promise<boolean> {
    try {
      const models = await ollama.list();
      return models.models.some((m) => m.name === modelName);
    } catch (error) {
      logger.error(`Failed to check model availability: ${error}`);
      return false;
    }
  }

  /**
   * Pull a model if not available
   */
  async ensureModel(modelName: string): Promise<void> {
    if (await this.isModelAvailable(modelName)) {
      logger.info(`Model ${modelName} is already available`);
      return;
    }

    logger.info(`Pulling model ${modelName}...`);
    await ollama.pull({ model: modelName });
    logger.info(`Model ${modelName} pulled successfully`);
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

    // llmLogger.info(stats);
    // llmLogger.info(response.message);

    logger.info(`LLM stats: ${JSON.stringify(stats)}`);
  }

  /**
   * Simple delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
