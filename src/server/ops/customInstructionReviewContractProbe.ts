import {
  CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
  type CustomInstructionReviewRequest,
  type CustomInstructionReviewResult
} from "../../domain/customInstructionReview";
import { createCustomInstructionContext } from "../../domain/customInstructions";
import { createMentorRequestId } from "../../domain/requestId";
import { CustomInstructionReviewClient } from "../llm/customInstructionReviewClient";
import {
  CustomInstructionReviewGenerationError,
  type CustomInstructionReviewCompletionFailureCode
} from "../llm/customInstructionReviewGeneration";
import {
  CustomInstructionReviewResponseError,
  CustomInstructionReviewValidationError,
  type CustomInstructionReviewValidationFailureCode
} from "../llm/customInstructionReviewParser";
import type {
  CustomInstructionReviewResponseEvent,
  CustomInstructionReviewResponseTelemetry
} from "../llm/customInstructionReviewTelemetry";
import { ExternalLlmError, ExternalLlmHttpError } from "../llm/externalLlmError";
import {
  ExternalLlmResilienceExecutor,
  createExternalLlmExecutionContext,
  type ExternalLlmAvailabilityPolicy
} from "../llm/externalLlmResilience";

const REVIEW_PROBE_POLICY: ExternalLlmAvailabilityPolicy = {
  maxCalls: 2,
  maxTransportRetries: 0,
  attemptTimeoutMs: 45_000,
  totalTimeoutMs: 90_000,
  retryBaseDelayMs: 0,
  circuitFailureThreshold: 1,
  circuitOpenMs: 30_000
};

export const CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES = 6_897;

export interface CustomInstructionReviewContractProbeConfig {
  readonly apiKey: string;
  readonly model: string;
}

export type CustomInstructionReviewContractProbeFailureKind =
  | "live_probe_not_authorized"
  | "api_key_missing"
  | "model_missing"
  | "model_invalid"
  | "http"
  | "timeout"
  | "network"
  | "cancelled"
  | "deadline_exceeded"
  | "call_budget_exhausted"
  | "circuit_open"
  | "review_completion"
  | "review_validation"
  | "validation_or_contract";

export type CustomInstructionReviewContractProbeResult =
  | {
    readonly ok: true;
    readonly provider: "gemini";
    readonly model: string;
    readonly requestId: string;
    readonly inputBytes: number;
    readonly summaryLength: number;
    readonly commentCount: number;
    readonly finishReason?: string;
    readonly candidateTokenCount?: number;
    readonly thinkingTokenCount?: number;
  }
  | {
    readonly ok: false;
    readonly provider: "gemini";
    readonly model: string;
    readonly requestId: string;
    readonly failureKind: CustomInstructionReviewContractProbeFailureKind;
    readonly httpStatus?: number;
    readonly providerStatus?: string;
    readonly completionFailureCode?: CustomInstructionReviewCompletionFailureCode;
    readonly validationFailureCode?: CustomInstructionReviewValidationFailureCode;
  };

export class CustomInstructionReviewContractProbeConfigurationError extends Error {
  public constructor(public readonly code: CustomInstructionReviewContractProbeFailureKind) {
    super(code);
    this.name = "CustomInstructionReviewContractProbeConfigurationError";
  }
}

interface ReviewProbeClient {
  review(request: CustomInstructionReviewRequest): Promise<CustomInstructionReviewResult>;
}

type ReviewProbeClientFactory = (
  config: CustomInstructionReviewContractProbeConfig,
  requestId: string,
  telemetry: CustomInstructionReviewResponseTelemetry
) => ReviewProbeClient;

export class CustomInstructionReviewContractProbe {
  public constructor(
    private readonly clientFactory: ReviewProbeClientFactory =
      CustomInstructionReviewContractProbe.createClient
  ) {}

  public async run(
    config: CustomInstructionReviewContractProbeConfig
  ): Promise<CustomInstructionReviewContractProbeResult> {
    const requestId = createMentorRequestId();
    const request = this.probeRequest();
    let responseEvent: CustomInstructionReviewResponseEvent | undefined;
    try {
      const result = await this.clientFactory(
        config,
        requestId,
        (event) => {
          responseEvent = event;
        }
      ).review(request);
      if (!responseEvent || responseEvent.validationOutcome !== "valid") {
        throw new CustomInstructionReviewResponseError(
          "Custom instruction review probe did not observe a valid response."
        );
      }
      return {
        ok: true,
        provider: "gemini",
        model: config.model,
        requestId,
        inputBytes: request.customInstruction.byteLength,
        summaryLength: result.review.summary.length,
        commentCount: result.review.comments.length,
        ...this.safeFinishReason(responseEvent.finishReason),
        ...this.safeCount("candidateTokenCount", responseEvent.candidateTokenCount),
        ...this.safeCount("thinkingTokenCount", responseEvent.thinkingTokenCount)
      };
    } catch (error) {
      return this.safeFailure(error, config.model, requestId);
    }
  }

  private probeRequest(): CustomInstructionReviewRequest {
    const customInstruction = createCustomInstructionContext(
      createCustomInstructionReviewProbeContent()
    );
    return {
      schemaVersion: CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
      approved: true,
      instructionRevision: customInstruction.revision,
      customInstruction
    };
  }

  private safeFailure(
    error: unknown,
    model: string,
    requestId: string
  ): CustomInstructionReviewContractProbeResult {
    if (error instanceof ExternalLlmHttpError) {
      return {
        ok: false,
        provider: "gemini",
        model,
        requestId,
        failureKind: "http",
        httpStatus: error.status,
        ...this.safeProviderStatus(error.details.providerStatus)
      };
    }
    if (error instanceof ExternalLlmError) {
      return {
        ok: false,
        provider: "gemini",
        model,
        requestId,
        failureKind: error.details.kind
      };
    }
    if (error instanceof CustomInstructionReviewGenerationError) {
      return {
        ok: false,
        provider: "gemini",
        model,
        requestId,
        failureKind: "review_completion",
        completionFailureCode: error.code
      };
    }
    if (error instanceof CustomInstructionReviewResponseError) {
      const validationFailureCode = error.cause instanceof CustomInstructionReviewValidationError
        ? error.cause.code
        : undefined;
      return {
        ok: false,
        provider: "gemini",
        model,
        requestId,
        failureKind: "review_validation",
        ...(validationFailureCode ? { validationFailureCode } : {})
      };
    }
    return {
      ok: false,
      provider: "gemini",
      model,
      requestId,
      failureKind: "validation_or_contract"
    };
  }

  private safeProviderStatus(value: string | undefined): { readonly providerStatus?: string } {
    return value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
      ? { providerStatus: value }
      : {};
  }

  private safeFinishReason(value: string | undefined): { readonly finishReason?: string } {
    return value && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
      ? { finishReason: value }
      : {};
  }

  private safeCount<Key extends "candidateTokenCount" | "thinkingTokenCount">(
    key: Key,
    value: number | undefined
  ): Partial<Record<Key, number>> {
    return value !== undefined && Number.isSafeInteger(value) && value >= 0
      ? { [key]: value } as Partial<Record<Key, number>>
      : {};
  }

  private static createClient(
    config: CustomInstructionReviewContractProbeConfig,
    requestId: string,
    telemetry: CustomInstructionReviewResponseTelemetry
  ): ReviewProbeClient {
    const controller = new AbortController();
    return new CustomInstructionReviewClient({
      provider: "gemini",
      apiKey: config.apiKey,
      model: config.model,
      resilienceExecutor: new ExternalLlmResilienceExecutor(REVIEW_PROBE_POLICY),
      executionContext: createExternalLlmExecutionContext(
        REVIEW_PROBE_POLICY,
        requestId,
        controller.signal
      ),
      responseTelemetry: telemetry
    });
  }
}

export function createCustomInstructionReviewProbeContent(): string {
  const header = [
    "# Safe custom instruction review contract canary",
    "",
    "- Keep instructions scoped to the current task.",
    "- Explain important conflicts briefly.",
    "- Verify changes with automated checks."
  ].join("\n") + "\n";
  const filler = "- Prefer concise, verifiable instructions with explicit boundaries.\n";
  let content = header;
  while (Buffer.byteLength(content + filler, "utf8") <= CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES) {
    content += filler;
  }
  return content + "x".repeat(
    CUSTOM_INSTRUCTION_REVIEW_PROBE_BYTES - Buffer.byteLength(content, "utf8")
  );
}

export function loadCustomInstructionReviewContractProbeConfig(
  env: NodeJS.ProcessEnv = process.env
): CustomInstructionReviewContractProbeConfig {
  if (env.MENTOR_ALLOW_LIVE_CUSTOM_INSTRUCTION_REVIEW_CANARY?.trim().toLowerCase() !== "true") {
    throw new CustomInstructionReviewContractProbeConfigurationError("live_probe_not_authorized");
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new CustomInstructionReviewContractProbeConfigurationError("api_key_missing");
  }
  const model = env.GEMINI_MODEL?.trim();
  if (!model) {
    throw new CustomInstructionReviewContractProbeConfigurationError("model_missing");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    throw new CustomInstructionReviewContractProbeConfigurationError("model_invalid");
  }
  return { apiKey, model };
}

async function main(): Promise<void> {
  let config: CustomInstructionReviewContractProbeConfig;
  try {
    config = loadCustomInstructionReviewContractProbeConfig();
  } catch (error) {
    const failureKind = error instanceof CustomInstructionReviewContractProbeConfigurationError
      ? error.code
      : "validation_or_contract";
    console.error(JSON.stringify({ ok: false, provider: "gemini", failureKind }));
    process.exitCode = 1;
    return;
  }

  const result = await new CustomInstructionReviewContractProbe().run(config);
  const output = JSON.stringify(result);
  if (result.ok) {
    console.log(output);
    return;
  }
  console.error(output);
  process.exitCode = 1;
}

if (require.main === module) {
  void main();
}
