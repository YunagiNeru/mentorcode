import { createMentorRequestId } from "../../domain/requestId";
import type { ContextPackage, MentorRequest, MentorResponse } from "../../domain/types";
import { GeminiClient } from "../llm/geminiClient";
import {
  ExternalLlmResilienceExecutor,
  createExternalLlmExecutionContext,
  type ExternalLlmAvailabilityPolicy
} from "../llm/externalLlmResilience";
import { ExternalLlmError, ExternalLlmHttpError } from "../llm/externalLlmError";

const PROBE_POLICY: ExternalLlmAvailabilityPolicy = {
  maxCalls: 1,
  maxTransportRetries: 0,
  attemptTimeoutMs: 45_000,
  totalTimeoutMs: 55_000,
  retryBaseDelayMs: 0,
  circuitFailureThreshold: 1,
  circuitOpenMs: 30_000
};

const PROBE_REQUEST: MentorRequest = {
  task: [
    "これは固定のAPI契約確認です。",
    "titleを「Gemini契約確認」とし、sectionsを1件以上、policyWarningsを配列として返してください。",
    "toolCallsとmanualImplementationは不要です。"
  ].join(" ")
};

const PROBE_CONTEXT: ContextPackage = {
  files: [],
  blockedFiles: [],
  summary: {
    scannedFiles: 0,
    includedFiles: 0,
    blockedFiles: 0,
    maskedFindings: 0,
    warningFindings: 0,
    criticalFindings: 0
  }
};

export interface GeminiContractProbeConfig {
  readonly apiKey: string;
  readonly model: string;
}

export type GeminiContractProbeFailureKind =
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
  | "validation_or_contract";

export type GeminiContractProbeResult =
  | {
    readonly ok: true;
    readonly provider: "gemini";
    readonly model: string;
    readonly requestId: string;
    readonly sectionCount: number;
    readonly hasPolicyWarnings: boolean;
  }
  | {
    readonly ok: false;
    readonly provider: "gemini";
    readonly model: string;
    readonly requestId: string;
    readonly failureKind: GeminiContractProbeFailureKind;
    readonly httpStatus?: number;
    readonly providerStatus?: string;
  };

export class GeminiContractProbeConfigurationError extends Error {
  public constructor(public readonly code: GeminiContractProbeFailureKind) {
    super(code);
    this.name = "GeminiContractProbeConfigurationError";
  }
}

interface GeminiProbeClient {
  createMentorResponse(
    request: MentorRequest,
    contextPackage: ContextPackage
  ): Promise<MentorResponse>;
}

type GeminiProbeClientFactory = (
  config: GeminiContractProbeConfig,
  requestId: string
) => GeminiProbeClient;

export class GeminiContractProbe {
  public constructor(
    private readonly clientFactory: GeminiProbeClientFactory = GeminiContractProbe.createClient
  ) {}

  public async run(config: GeminiContractProbeConfig): Promise<GeminiContractProbeResult> {
    const requestId = createMentorRequestId();
    try {
      const response = await this.clientFactory(config, requestId)
        .createMentorResponse(PROBE_REQUEST, PROBE_CONTEXT);
      return {
        ok: true,
        provider: "gemini",
        model: config.model,
        requestId,
        sectionCount: response.sections.length,
        hasPolicyWarnings: response.policyWarnings.length > 0
      };
    } catch (error) {
      return this.safeFailure(error, config.model, requestId);
    }
  }

  private safeFailure(
    error: unknown,
    model: string,
    requestId: string
  ): GeminiContractProbeResult {
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
    return {
      ok: false,
      provider: "gemini",
      model,
      requestId,
      failureKind: "validation_or_contract"
    };
  }

  private safeProviderStatus(value: string | undefined): { readonly providerStatus?: string } {
    if (!value || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) {
      return {};
    }
    return { providerStatus: value };
  }

  private static createClient(
    config: GeminiContractProbeConfig,
    requestId: string
  ): GeminiProbeClient {
    const controller = new AbortController();
    return new GeminiClient({
      apiKey: config.apiKey,
      model: config.model,
      resilienceExecutor: new ExternalLlmResilienceExecutor(PROBE_POLICY),
      executionContext: createExternalLlmExecutionContext(
        PROBE_POLICY,
        requestId,
        controller.signal
      )
    });
  }
}

export function loadGeminiContractProbeConfig(
  env: NodeJS.ProcessEnv = process.env
): GeminiContractProbeConfig {
  if (env.MENTOR_ALLOW_LIVE_GEMINI_CANARY?.trim().toLowerCase() !== "true") {
    throw new GeminiContractProbeConfigurationError("live_probe_not_authorized");
  }
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiContractProbeConfigurationError("api_key_missing");
  }
  const model = env.GEMINI_MODEL?.trim();
  if (!model) {
    throw new GeminiContractProbeConfigurationError("model_missing");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    throw new GeminiContractProbeConfigurationError("model_invalid");
  }
  return { apiKey, model };
}

async function main(): Promise<void> {
  let config: GeminiContractProbeConfig;
  try {
    config = loadGeminiContractProbeConfig();
  } catch (error) {
    const failureKind = error instanceof GeminiContractProbeConfigurationError
      ? error.code
      : "validation_or_contract";
    console.error(JSON.stringify({
      ok: false,
      provider: "gemini",
      failureKind
    }));
    process.exitCode = 1;
    return;
  }

  const result = await new GeminiContractProbe().run(config);
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
