import { CustomInstructionReviewResponseError } from "./customInstructionReviewParser";

export type CustomInstructionReviewCompletionFailureCode =
  | "max_tokens"
  | "prompt_blocked"
  | "candidate_blocked"
  | "missing_candidate"
  | "missing_text"
  | "incomplete_response";

export class CustomInstructionReviewGenerationError extends CustomInstructionReviewResponseError {
  public constructor(
    public readonly code: CustomInstructionReviewCompletionFailureCode
  ) {
    super(`Custom instruction review generation did not complete: ${code}.`);
    this.name = "CustomInstructionReviewGenerationError";
  }
}
