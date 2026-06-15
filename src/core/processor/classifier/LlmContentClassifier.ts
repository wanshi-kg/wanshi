import z from "zod";
import { Logger } from "../../../shared";
import { ClassificationResult, ILLMProvider, LLMMessage } from "../../../types";
import { IContentClassifier } from "./IContentTypeClassifier";

const ResponseSchema = z.object({
  class: z.enum([
    "code",
    "financial",
    "medical",
    "legal",
    "research",
    "transcript",
    "tabular",
    "communication",
    "documentation",
    "technical",
    "narrative",
    "reference",
  ]),
  confidence: z.number(),
});

const ClassifierSystemPrompt = `# MISSION STATEMENT

You are a text classification assistant. Your task is to classify the provided text content into one of the predefined classes. Your goal is to accurately determine the category of the text based on its content and context.

## Class Definitions

1. **code**: Text containing programming code, scripts, or any form of computer language syntax.
2. **financial**: Text related to financial data, reports, transactions, or economic analysis.
3. **medical**: Text pertaining to medical information, health records, clinical notes, or healthcare-related content.
4. **legal**: Text involving legal documents, contracts, laws, regulations, or any legal proceedings.
5. **research**: Text related to academic research, scientific studies, or scholarly articles.
6. **transcript**: Text that is a transcription of spoken language, such as interviews, meetings, or lectures.
7. **tabular**: Text presented in a tabular format, such as tables, spreadsheets, or structured data.
8. **communication**: Text involving personal or professional communication, such as emails, messages, or letters.
9. **documentation**: Text that serves as documentation, such as manuals, guides, or instructional content.
10. **technical**: Text related to technical specifications, engineering details, or technical manuals.
11. **narrative**: Text that tells a story or describes events, such as novels, stories, or anecdotes.
12. **reference**: Text that serves as a reference, such as encyclopedias, dictionaries, or reference guides.

## Response Format

Please provide your response in the following JSON schema:

\`\`\`json
{
  "class": "code" | "financial" | "medical" | "legal" | "research" | "transcript" | "tabular" | "communication" | "documentation" | "technical" | "narrative" | "reference",
  "confidence": number
}
\`\`\`

## Critical Instructions

1. Read the provided text carefully.
2. Determine the most appropriate class for the text based on the definitions provided.
3. Assign a confidence score between 0 and 1, where 1 indicates absolute certainty and 0 indicates complete uncertainty.
4. Return the response in the specified JSON format.

Ensure that your classification is accurate and that the confidence score reflects your certainty in the classification.
`;

export class LlmContentClassifier implements IContentClassifier {
  constructor(
    private readonly llm: ILLMProvider,
    private readonly logger: Logger
  ) {}

  async classify(
    content: string,
    path: string
  ): Promise<ClassificationResult[]> {
    // Returns a single `{class, confidence}` (the model's pick) — consumed by the
    // exact same gate as the heuristic (`vocabulary.ts:activeDomainClasses`). After
    // S2/S3 both classifiers feed that gate a comparable [0,1] confidence and there
    // is no classifier-internal threshold: the heuristic emits a softmax
    // distribution, the LLM emits the model's own probability, and the single
    // downstream gate decides abstain/single/multi for both.
    //
    // Route through the provider-agnostic ILLMProvider (KG-15). Previously this
    // hardcoded an Ollama client + host, so with `provider: openai` every call
    // hit `/api/chat` on a cloud base URL and 404'd. generateStructured already
    // does JSON-schema formatting, fence-stripping, zod-validation, and retry —
    // so the manual chat/parse/validate dance is gone. Failures propagate (the
    // caller — FileProcessor/CorpusAnalyzer — handles them gracefully).
    const messages: LLMMessage[] = [
      { role: "system", content: ClassifierSystemPrompt },
      { role: "user", content: this.formatMessage(content, path) },
    ];

    this.logger.debug(`Classifying ${path} via LLM provider`);
    const validated = await this.llm.generateStructured(messages, ResponseSchema);
    return [validated];
  }

  private formatMessage(content: string, path: string): string {
    return `File Path: \`${path}\`\nFile Content:\n\`\`\`\n${content}\n\`\`\`\n`;
  }
}
