import {
  CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION,
  type CustomInstructionLlmReview,
  type CustomInstructionReviewRequest,
  type CustomInstructionReviewResult
} from "../../src/domain/customInstructionReview";
import { createCustomInstructionContext } from "../../src/domain/customInstructions";

export function validCustomInstructionReview(): CustomInstructionLlmReview {
  return {
    schema_version: CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION,
    summary: "全体として意図は伝わりますが、完了条件をもう少し具体化できます。",
    comments: [
      "「変更後はテストを実行する」だけでは、どの結果を成功とするかが人によって変わります。実行するコマンドと期待結果を一緒に示すと、完了判定が安定します。"
    ]
  };
}

export function validCustomInstructionReviewRequest(
  content = "変更後は `npm test` を実行する。"
): CustomInstructionReviewRequest {
  const customInstruction = createCustomInstructionContext(content);
  return {
    schemaVersion: CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
    approved: true,
    instructionRevision: customInstruction.revision,
    customInstruction
  };
}

export function validCustomInstructionReviewResult(
  request = validCustomInstructionReviewRequest()
): CustomInstructionReviewResult {
  return {
    schemaVersion: CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION,
    instructionRevision: request.instructionRevision,
    review: validCustomInstructionReview(),
    modelId: "test-review-model",
    reviewPromptVersion: CUSTOM_INSTRUCTION_REVIEW_PROMPT_VERSION,
    platformSpecVersion: CUSTOM_INSTRUCTION_PLATFORM_SPEC_VERSION,
    reviewedAt: "2026-07-16T00:00:00.000Z"
  };
}
