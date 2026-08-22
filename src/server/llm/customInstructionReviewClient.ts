import {
  CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION,
  type CustomInstructionLlmReview,
  type CustomInstructionReviewRequest,
  type CustomInstructionReviewResult
} from "../../domain/customInstructionReview";
import {
  type ExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor
} from "./externalLlmResilience";
import { CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA } from "./customInstructionReviewJsonSchema";
import {
  CustomInstructionReviewGenerationError,
  type CustomInstructionReviewCompletionFailureCode
} from "./customInstructionReviewGeneration";
import {
  CustomInstructionReviewParser,
  CustomInstructionReviewResponseError,
  CustomInstructionReviewValidationError,
  type CustomInstructionReviewValidationFailureCode
} from "./customInstructionReviewParser";
import {
  CustomInstructionReviewPromptBuilder,
  type CustomInstructionReviewRepairReason
} from "./customInstructionReviewPrompt";
import type {
  CustomInstructionReviewResponseEvent,
  CustomInstructionReviewResponseTelemetry
} from "./customInstructionReviewTelemetry";
import {
  geminiThinkingConfig,
  openAiReasoningConfig,
  type GeminiThinkingOptions,
  type OpenAiReasoningEffort
} from "./reasoning";

interface OpenAiReviewResponseBody {
  readonly output_text?: string;
  readonly output?: readonly {
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
    }[];
  }[];
}

interface GeminiReviewResponseBody {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        readonly thought?: boolean;
      }[];
    };
    readonly finishReason?: string;
  }[];
  readonly promptFeedback?: {
    readonly blockReason?: string;
  };
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly totalTokenCount?: number;
  };
}

interface ReviewResponseMetadata {
  readonly candidateCount?: number;
  readonly partCount?: number;
  readonly textPartCount?: number;
  readonly thinkingTextPartCount?: number;
  readonly finishReason?: string;
  readonly promptBlockReason?: string;
  readonly promptTokenCount?: number;
  readonly candidateTokenCount?: number;
  readonly thinkingTokenCount?: number;
  readonly totalTokenCount?: number;
}

interface ReviewResponse {
  readonly text: string;
  readonly metadata: ReviewResponseMetadata;
}

type ReviewFetchReason = "initial" | "format_repair" | "token_recovery";

export interface CustomInstructionReviewClientOptions {
  readonly provider: "openai" | "gemini";
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly thinking?: GeminiThinkingOptions;
  readonly resilienceExecutor: ExternalLlmResilienceExecutor;
  readonly executionContext: ExternalLlmExecutionContext;
  readonly responseTelemetry?: CustomInstructionReviewResponseTelemetry;
}

export class CustomInstructionReviewClient {
  private readonly promptBuilder = new CustomInstructionReviewPromptBuilder();
  private readonly parser = new CustomInstructionReviewParser();

  public constructor(private readonly options: CustomInstructionReviewClientOptions) {}

  public async review(request: CustomInstructionReviewRequest): Promise<CustomInstructionReviewResult> {
    const initialResponse = await this.fetchReview(request, 1, "initial");
    const initialCompletionFailure = this.completionFailure(initialResponse);
    if (initialCompletionFailure) {
      this.recordResponse(initialResponse, 1, "invalid", initialCompletionFailure.code);
      if (initialCompletionFailure.code !== "max_tokens") {
        throw initialCompletionFailure;
      }

      const recoveredResponse = await this.fetchReview(request, 2, "token_recovery");
      const review = this.parseFinalResponse(recoveredResponse, 2);
      return this.result(request, review);
    }

    try {
      const review = this.parser.parse(initialResponse.text);
      this.recordResponse(initialResponse, 1, "valid");
      return this.result(request, review);
    } catch (cause) {
      const validationFailureCode = this.validationFailureCode(cause);
      this.recordResponse(initialResponse, 1, "invalid", undefined, validationFailureCode);
      const repairedResponse = await this.fetchReview(
        request,
        2,
        "format_repair",
        validationFailureCode
      );
      const review = this.parseFinalResponse(repairedResponse, 2);
      return this.result(request, review);
    }
  }

  private result(
    request: CustomInstructionReviewRequest,
    review: CustomInstructionLlmReview
  ): CustomInstructionReviewResult {
    return {
      schemaVersion: CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION,
      instructionRevision: request.instructionRevision,
      review,
      modelId: this.options.model,
      reviewPromptVersion: CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION,
      platformSpecVersion: CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION,
      reviewedAt: new Date().toISOString()
    };
  }

  private fetchReview(
    request: CustomInstructionReviewRequest,
    responseAttempt: number,
    reason: ReviewFetchReason,
    repairReason?: CustomInstructionReviewRepairReason
  ): Promise<ReviewResponse> {
    return this.options.provider === "openai"
      ? this.fetchOpenAi(request, responseAttempt, repairReason)
      : this.fetchGemini(request, responseAttempt, reason, repairReason);
  }

  private async fetchOpenAi(
    request: CustomInstructionReviewRequest,
    responseAttempt: number,
    repairReason?: CustomInstructionReviewRepairReason
  ): Promise<ReviewResponse> {
    const body = await this.options.resilienceExecutor.execute<OpenAiReviewResponseBody>({
      provider: "openai",
      model: this.options.model,
      responseAttempt,
      context: this.options.executionContext,
      operation: (signal) => fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          max_output_tokens: 1_600,
          ...openAiReasoningConfig(this.options.reasoningEffort),
          input: [
            {
              role: "developer",
              content: [{
                type: "input_text",
                text: this.promptBuilder.developerInstructions(responseAttempt, repairReason)
              }]
            },
            {
              role: "user",
              content: [{ type: "input_text", text: this.promptBuilder.userPayload(request) }]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "custom_instruction_review",
              strict: true,
              schema: CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA
            }
          }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<OpenAiReviewResponseBody>
    });
    const text = body.output_text ?? body.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
    return {
      text: text ?? "",
      metadata: {
        candidateCount: body.output?.length ?? (body.output_text === undefined ? 0 : 1),
        partCount: body.output?.reduce((total, item) => total + (item.content?.length ?? 0), 0) ?? 0
      }
    };
  }

  private async fetchGemini(
    request: CustomInstructionReviewRequest,
    responseAttempt: number,
    reason: ReviewFetchReason,
    repairReason?: CustomInstructionReviewRepairReason
  ): Promise<ReviewResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`;
    const body = await this.options.resilienceExecutor.execute<GeminiReviewResponseBody>({
      provider: "gemini",
      model: this.options.model,
      responseAttempt,
      context: this.options.executionContext,
      operation: (signal) => fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.options.apiKey
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{
              text: this.promptBuilder.developerInstructions(
                responseAttempt,
                reason === "token_recovery" ? "max_tokens" : repairReason
              )
            }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: this.promptBuilder.userPayload(request) }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA,
            maxOutputTokens: reason === "token_recovery" ? 8_192 : 4_096,
            ...geminiThinkingConfig(this.options.thinking ?? {}, "minimal")
          }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<GeminiReviewResponseBody>
    });
    const candidate = body.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const textParts = parts.filter((part) => typeof part.text === "string");
    const answerTextParts = textParts.filter((part) => part.thought !== true);
    return {
      text: answerTextParts.map((part) => part.text).join(""),
      metadata: {
        candidateCount: body.candidates?.length ?? 0,
        partCount: parts.length,
        textPartCount: textParts.length,
        thinkingTextPartCount: textParts.filter((part) => part.thought === true).length,
        ...(candidate?.finishReason ? { finishReason: candidate.finishReason } : {}),
        ...(body.promptFeedback?.blockReason
          ? { promptBlockReason: body.promptFeedback.blockReason }
          : {}),
        ...(typeof body.usageMetadata?.promptTokenCount === "number"
          ? { promptTokenCount: body.usageMetadata.promptTokenCount }
          : {}),
        ...(typeof body.usageMetadata?.candidatesTokenCount === "number"
          ? { candidateTokenCount: body.usageMetadata.candidatesTokenCount }
          : {}),
        ...(typeof body.usageMetadata?.thoughtsTokenCount === "number"
          ? { thinkingTokenCount: body.usageMetadata.thoughtsTokenCount }
          : {}),
        ...(typeof body.usageMetadata?.totalTokenCount === "number"
          ? { totalTokenCount: body.usageMetadata.totalTokenCount }
          : {})
      }
    };
  }

  private recordResponse(
    response: ReviewResponse,
    responseAttempt: number,
    validationOutcome: CustomInstructionReviewResponseEvent["validationOutcome"],
    completionFailureCode?: CustomInstructionReviewCompletionFailureCode,
    validationFailureCode?: CustomInstructionReviewValidationFailureCode
  ): void {
    this.options.responseTelemetry?.({
      event: "custom_instruction_review_response",
      requestId: this.options.executionContext.requestId,
      provider: this.options.provider,
      model: this.options.model,
      responseAttempt,
      validationOutcome,
      textLength: response.text.length,
      ...(completionFailureCode ? { completionFailureCode } : {}),
      ...(validationFailureCode ? { validationFailureCode } : {}),
      ...response.metadata
    });
  }

  private parseFinalResponse(
    response: ReviewResponse,
    responseAttempt: number
  ): CustomInstructionLlmReview {
    const completionFailure = this.completionFailure(response);
    if (completionFailure) {
      this.recordResponse(response, responseAttempt, "invalid", completionFailure.code);
      throw completionFailure;
    }

    try {
      const review = this.parser.parse(response.text);
      this.recordResponse(response, responseAttempt, "valid");
      return review;
    } catch (cause) {
      this.recordResponse(
        response,
        responseAttempt,
        "invalid",
        undefined,
        this.validationFailureCode(cause)
      );
      throw new CustomInstructionReviewResponseError(
        "Custom instruction review response validation failed after one repair attempt.",
        { cause }
      );
    }
  }

  private completionFailure(
    response: ReviewResponse
  ): CustomInstructionReviewGenerationError | undefined {
    if (this.options.provider !== "gemini") {
      return undefined;
    }
    if (response.metadata.promptBlockReason) {
      return new CustomInstructionReviewGenerationError("prompt_blocked");
    }
    if (response.metadata.candidateCount === 0) {
      return new CustomInstructionReviewGenerationError("missing_candidate");
    }
    if (response.metadata.finishReason === "MAX_TOKENS") {
      return new CustomInstructionReviewGenerationError("max_tokens");
    }
    if (this.isBlockedFinishReason(response.metadata.finishReason)) {
      return new CustomInstructionReviewGenerationError("candidate_blocked");
    }
    if (response.metadata.finishReason && response.metadata.finishReason !== "STOP") {
      return new CustomInstructionReviewGenerationError("incomplete_response");
    }
    if (!response.text) {
      return new CustomInstructionReviewGenerationError("missing_text");
    }
    return undefined;
  }

  private isBlockedFinishReason(finishReason: string | undefined): boolean {
    return finishReason !== undefined && [
      "SAFETY",
      "RECITATION",
      "LANGUAGE",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII"
    ].includes(finishReason);
  }

  private validationFailureCode(
    cause: unknown
  ): CustomInstructionReviewValidationFailureCode | undefined {
    return cause instanceof CustomInstructionReviewValidationError
      ? cause.code
      : undefined;
  }
}
