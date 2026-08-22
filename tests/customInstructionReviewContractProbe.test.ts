import { describe, expect, it } from "vitest";
import {
  CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES,
  CustomInstructionReviewContractProbe,
  CustomInstructionReviewContractProbeConfigurationError,
  createCustomInstructionReviewProbeContent,
  loadCustomInstructionReviewContractProbeConfig
} from "../src/server/ops/customInstructionReviewContractProbe";
import { CustomInstructionReviewGenerationError } from "../src/server/llm/customInstructionReviewGeneration";
import { validCustomInstructionReviewResult } from "./fixtures/customInstructionReview";

describe("CustomInstructionReviewContractProbe", () => {
  it("requires explicit live authorization and validated Gemini configuration", () => {
    expect(() => loadCustomInstructionReviewContractProbeConfig({
      GEMINI_API_KEY: "secret",
      GEMINI_MODEL: "gemini-3.5-flash"
    })).toThrow(expect.objectContaining({
      code: "live_probe_not_authorized"
    } satisfies Partial<CustomInstructionReviewContractProbeConfigurationError>));
    expect(() => loadCustomInstructionReviewContractProbeConfig({
      MENTOR_ALLOW_LIVE_CUSTOM_INSTRUCTION_REVIEW_CANARY: "true",
      GEMINI_API_KEY: "secret",
      GEMINI_MODEL: "invalid/model"
    })).toThrow(expect.objectContaining({ code: "model_invalid" }));
  });

  it("uses a fixed safe 6897-byte input and returns metadata without review text", async () => {
    let observedBytes = 0;
    const probe = new CustomInstructionReviewContractProbe((config, requestId, telemetry) => ({
      review: async (request) => {
        observedBytes = request.customInstruction.byteLength;
        telemetry({
          event: "custom_instruction_review_response",
          requestId,
          provider: "gemini",
          model: config.model,
          responseAttempt: 1,
          validationOutcome: "valid",
          textLength: 640,
          finishReason: "STOP",
          candidateTokenCount: 421,
          thinkingTokenCount: 0
        });
        return validCustomInstructionReviewResult(request);
      }
    }));

    const result = await probe.run({ apiKey: "secret", model: "gemini-3.5-flash" });

    expect(Buffer.byteLength(createCustomInstructionReviewProbeContent(), "utf8")).toBe(
      CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES
    );
    expect(observedBytes).toBe(CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES);
    expect(result).toMatchObject({
      ok: true,
      inputBytes: CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES,
      finishReason: "STOP",
      candidateTokenCount: 421,
      thinkingTokenCount: 0
    });
    expect(JSON.stringify(result)).not.toContain(validCustomInstructionReviewResult().review.summary);
  });

  it("returns only a safe completion code when review generation fails", async () => {
    const probe = new CustomInstructionReviewContractProbe(() => ({
      review: () => Promise.reject(new CustomInstructionReviewGenerationError("max_tokens"))
    }));

    const result = await probe.run({ apiKey: "secret", model: "gemini-3.5-flash" });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "review_completion",
      completionFailureCode: "max_tokens"
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
