import {
  CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION,
  parseCapabilityReview,
  type CapabilityReviewRequest,
  type CapabilityReviewResult
} from "../../domain/capabilityReview";
import { type ExternalLlmExecutionContext, ExternalLlmResilienceExecutor } from "./externalLlmResilience";
import { CAPABILITY_REVIEW_JSON_SCHEMA } from "./capabilityReviewJsonSchema";
import { CapabilityReviewPromptBuilder } from "./capabilityReviewPrompt";
import {
  geminiThinkingConfig,
  openAiReasoningConfig,
  type GeminiThinkingOptions,
  type OpenAiReasoningEffort
} from "./reasoning";

interface OpenAiBody {
  readonly output_text?: string;
  readonly output?: readonly { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }[];
}

interface GeminiBody {
  readonly candidates?: readonly { readonly content?: { readonly parts?: readonly { readonly text?: string; readonly thought?: boolean }[] } }[];
}

export interface CapabilityReviewClientOptions {
  readonly provider: "openai" | "gemini";
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly thinking?: GeminiThinkingOptions;
  readonly resilienceExecutor: ExternalLlmResilienceExecutor;
  readonly executionContext: ExternalLlmExecutionContext;
}

export class CapabilityReviewClient {
  private readonly prompt = new CapabilityReviewPromptBuilder();

  public constructor(private readonly options: CapabilityReviewClientOptions) {}

  public async review(request: CapabilityReviewRequest): Promise<CapabilityReviewResult> {
    const text = this.options.provider === "openai"
      ? await this.fetchOpenAi(request)
      : await this.fetchGemini(request);
    return {
      schemaVersion: CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION,
      revision: request.revision,
      review: parseCapabilityReview(JSON.parse(text) as unknown),
      modelId: this.options.model,
      reviewedAt: new Date().toISOString()
    };
  }

  private async fetchOpenAi(request: CapabilityReviewRequest): Promise<string> {
    const body = await this.options.resilienceExecutor.execute<OpenAiBody>({
      provider: "openai",
      model: this.options.model,
      responseAttempt: 1,
      context: this.options.executionContext,
      operation: (signal) => fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          max_output_tokens: 1_200,
          ...openAiReasoningConfig(this.options.reasoningEffort),
          input: [
            { role: "developer", content: [{ type: "input_text", text: this.prompt.developerInstructions() }] },
            { role: "user", content: [{ type: "input_text", text: this.prompt.userPayload(request) }] }
          ],
          text: { format: { type: "json_schema", name: "capability_review", strict: true, schema: CAPABILITY_REVIEW_JSON_SCHEMA } }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<OpenAiBody>
    });
    return body.output_text ?? body.output?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text).join("") ?? "";
  }

  private async fetchGemini(request: CapabilityReviewRequest): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`;
    const body = await this.options.resilienceExecutor.execute<GeminiBody>({
      provider: "gemini",
      model: this.options.model,
      responseAttempt: 1,
      context: this.options.executionContext,
      operation: (signal) => fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: this.prompt.developerInstructions() }] },
          contents: [{ role: "user", parts: [{ text: this.prompt.userPayload(request) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: CAPABILITY_REVIEW_JSON_SCHEMA,
            maxOutputTokens: 1_200,
            ...geminiThinkingConfig(this.options.thinking ?? {}, "minimal")
          }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<GeminiBody>
    });
    return body.candidates?.[0]?.content?.parts
      ?.filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text).join("") ?? "";
  }
}
