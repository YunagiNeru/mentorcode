export type ExternalLlmProvider = "openai" | "gemini";

export type ExternalLlmFailureKind =
  | "http"
  | "timeout"
  | "network"
  | "cancelled"
  | "deadline_exceeded"
  | "call_budget_exhausted"
  | "circuit_open";

export interface ExternalLlmErrorDetails {
  readonly kind: ExternalLlmFailureKind;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly callNumber?: number;
  readonly providerStatus?: string;
  readonly providerMessage?: string;
  readonly retryAfterMs?: number;
  readonly networkCode?: string;
}

export abstract class ExternalLlmError extends Error {
  protected constructor(
    public readonly provider: ExternalLlmProvider,
    message: string,
    public readonly details: ExternalLlmErrorDetails
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ExternalLlmHttpError extends ExternalLlmError {
  public constructor(
    provider: ExternalLlmProvider,
    public readonly status: number,
    message: string,
    details: Omit<ExternalLlmErrorDetails, "kind"> = {
      retryable: false
    }
  ) {
    super(provider, message, {
      kind: "http",
      ...details
    });
  }
}

export class ExternalLlmExecutionError extends ExternalLlmError {
  public constructor(
    provider: ExternalLlmProvider,
    message: string,
    details: ExternalLlmErrorDetails
  ) {
    super(provider, message, details);
  }
}
