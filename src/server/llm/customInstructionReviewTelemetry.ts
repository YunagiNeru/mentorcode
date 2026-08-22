import type { ExternalLlmProvider } from "./externalLlmError";
import type { CustomInstructionReviewCompletionFailureCode } from "./customInstructionReviewGeneration";
import type { CustomInstructionReviewValidationFailureCode } from "./customInstructionReviewParser";

export type CustomInstructionReviewValidationOutcome = "valid" | "invalid";

export interface CustomInstructionReviewResponseEvent {
  readonly event: "custom_instruction_review_response";
  readonly requestId: string;
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  readonly responseAttempt: number;
  readonly validationOutcome: CustomInstructionReviewValidationOutcome;
  readonly completionFailureCode?: CustomInstructionReviewCompletionFailureCode;
  readonly validationFailureCode?: CustomInstructionReviewValidationFailureCode;
  readonly textLength: number;
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

export type CustomInstructionReviewResponseTelemetry = (
  event: CustomInstructionReviewResponseEvent
) => void;
