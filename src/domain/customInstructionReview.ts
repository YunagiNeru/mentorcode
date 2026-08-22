import type { CustomInstructionContext } from "./customInstructions";

export const CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION = "mentorcode.custom_instruction_review_request.v2";
export const CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION = "mentorcode.custom_instruction_review_result.v2";
export const CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION = "mentorcode.custom_instruction_review.v2";
export const CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION = "proposal-1.2026-07-16.v3";
export const CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION = "mentorcode.generic_api.2026-07-16.v1";

export interface CustomInstructionReviewRequest {
  readonly schemaVersion: typeof CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION;
  readonly approved: boolean;
  readonly instructionRevision: string;
  readonly customInstruction: CustomInstructionContext;
}

export interface CustomInstructionLlmReview {
  readonly schema_version: typeof CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION;
  readonly summary: string;
  readonly comments: readonly string[];
}

export interface CustomInstructionReviewResult {
  readonly schemaVersion: typeof CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION;
  readonly instructionRevision: string;
  readonly review: CustomInstructionLlmReview;
  readonly modelId: string;
  readonly reviewPromptVersion: typeof CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION;
  readonly platformSpecVersion: typeof CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION;
  readonly reviewedAt: string;
}

export function isCustomInstructionReviewRequest(value: unknown): value is CustomInstructionReviewRequest {
  if (!isRecord(value)) {
    return false;
  }

  const allowedKeys = new Set([
    "schemaVersion",
    "approved",
    "instructionRevision",
    "customInstruction"
  ]);
  return Object.keys(value).every((key) => allowedKeys.has(key)) &&
    value.schemaVersion === CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION &&
    value.approved === true &&
    typeof value.instructionRevision === "string" &&
    /^[a-f0-9]{64}$/.test(value.instructionRevision) &&
    isRecord(value.customInstruction);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
