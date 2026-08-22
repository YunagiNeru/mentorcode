import {
  ExternalLlmExecutionError,
  ExternalLlmHttpError,
  type ExternalLlmFailureKind,
  type ExternalLlmProvider
} from "./externalLlmError";
import {
  ExternalLlmCircuitBreaker,
  type ExternalLlmCircuitSnapshot
} from "./externalLlmCircuitBreaker";
import type { MentorProgressReporter } from "../../domain/mentorProgress";

export type ExternalLlmAttemptKind = "initial" | "response_repair" | "transport_retry";
export type ExternalLlmAttemptOutcome = "success" | "failure" | "retry_scheduled";

export interface ExternalLlmAvailabilityPolicy {
  readonly maxCalls: number;
  readonly maxTransportRetries: number;
  readonly attemptTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly retryBaseDelayMs: number;
  readonly circuitFailureThreshold: number;
  readonly circuitOpenMs: number;
}

export interface ExternalLlmAvailabilityConfigSource {
  readonly llmMaxCalls: number;
  readonly llmMaxTransportRetries: number;
  readonly llmAttemptTimeoutMs: number;
  readonly llmTotalTimeoutMs: number;
  readonly llmRetryBaseDelayMs: number;
  readonly llmCircuitFailureThreshold: number;
  readonly llmCircuitOpenMs: number;
}

export interface ExternalLlmAttemptEvent {
  readonly event: "external_llm_attempt";
  readonly requestId: string;
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  readonly callNumber: number;
  readonly responseAttempt: number;
  readonly attemptKind: ExternalLlmAttemptKind;
  readonly outcome: ExternalLlmAttemptOutcome;
  readonly elapsedMs: number;
  readonly retryable: boolean;
  readonly failureKind?: ExternalLlmFailureKind;
  readonly httpStatus?: number;
  readonly providerStatus?: string;
  readonly retryDelayMs?: number;
  readonly networkCode?: string;
}

export interface ExternalLlmExecutionContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly budget: ExternalLlmCallBudget;
  readonly progress?: MentorProgressReporter;
}

export interface ExternalLlmExecuteInput<T = Response> {
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  readonly responseAttempt: number;
  readonly context: ExternalLlmExecutionContext;
  readonly operation: (signal: AbortSignal) => Promise<Response>;
  readonly consumeResponse?: (response: Response, signal: AbortSignal) => Promise<T>;
}

export type ExternalLlmTelemetry = (event: ExternalLlmAttemptEvent) => void;

interface ExternalLlmResilienceDependencies {
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly telemetry?: ExternalLlmTelemetry;
  readonly circuitBreaker?: ExternalLlmCircuitBreaker;
}

interface ProviderErrorBody {
  readonly error?: {
    readonly status?: unknown;
    readonly message?: unknown;
  };
}

interface SafeProviderErrorDetails {
  readonly providerStatus?: string;
  readonly providerMessage?: string;
}

interface AttemptFailure {
  readonly kind: "failure";
  readonly error: ExternalLlmExecutionError;
  readonly elapsedMs: number;
}

interface AttemptResponse<T> {
  readonly kind: "response";
  readonly response: Response;
  readonly value?: T;
}

export class ExternalLlmCallBudget {
  private calls = 0;

  public constructor(
    private readonly maxCalls: number,
    private readonly deadlineAt: number,
    private readonly now: () => number = Date.now
  ) {}

  public reserve(provider: ExternalLlmProvider, requestId: string): number {
    if (this.remainingMs() <= 0) {
      throw new ExternalLlmExecutionError(
        provider,
        "External LLM request deadline was exceeded.",
        {
          kind: "deadline_exceeded",
          retryable: false,
          requestId
        }
      );
    }

    if (this.calls >= this.maxCalls) {
      throw new ExternalLlmExecutionError(
        provider,
        "External LLM call budget was exhausted.",
        {
          kind: "call_budget_exhausted",
          retryable: false,
          requestId
        }
      );
    }

    this.calls += 1;
    return this.calls;
  }

  public remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  public canStartAfter(delayMs: number): boolean {
    return this.calls < this.maxCalls && this.remainingMs() > delayMs;
  }

  public usedCalls(): number {
    return this.calls;
  }
}

export function createExternalLlmExecutionContext(
  policy: ExternalLlmAvailabilityPolicy,
  requestId: string,
  signal: AbortSignal,
  now: () => number = Date.now,
  progress?: MentorProgressReporter
): ExternalLlmExecutionContext {
  return {
    requestId,
    signal,
    budget: new ExternalLlmCallBudget(policy.maxCalls, now() + policy.totalTimeoutMs, now),
    ...(progress === undefined ? {} : { progress })
  };
}

export function externalLlmAvailabilityPolicyFrom(
  config: ExternalLlmAvailabilityConfigSource
): ExternalLlmAvailabilityPolicy {
  return {
    maxCalls: config.llmMaxCalls,
    maxTransportRetries: config.llmMaxTransportRetries,
    attemptTimeoutMs: config.llmAttemptTimeoutMs,
    totalTimeoutMs: config.llmTotalTimeoutMs,
    retryBaseDelayMs: config.llmRetryBaseDelayMs,
    circuitFailureThreshold: config.llmCircuitFailureThreshold,
    circuitOpenMs: config.llmCircuitOpenMs
  };
}

export class ExternalLlmResilienceExecutor {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly telemetry: ExternalLlmTelemetry;
  private readonly circuitBreaker: ExternalLlmCircuitBreaker;

  public constructor(
    private readonly policy: ExternalLlmAvailabilityPolicy,
    dependencies: ExternalLlmResilienceDependencies = {}
  ) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? this.sleepWithSignal;
    this.telemetry = dependencies.telemetry ?? (() => undefined);
    this.circuitBreaker = dependencies.circuitBreaker ?? new ExternalLlmCircuitBreaker({
      failureThreshold: policy.circuitFailureThreshold,
      openMs: policy.circuitOpenMs
    }, this.now);
  }

  public async execute<T = Response>(input: ExternalLlmExecuteInput<T>): Promise<T> {
    const permit = this.circuitBreaker.acquire(input.provider, input.model, input.context.requestId);
    try {
      const response = await this.executeWithRetries(input);
      this.circuitBreaker.recordSuccess(permit);
      return response;
    } catch (error) {
      if (error instanceof ExternalLlmExecutionError || error instanceof ExternalLlmHttpError) {
        this.circuitBreaker.recordFailure(
          permit,
          input.provider,
          input.model,
          error.details.retryable
        );
      } else {
        this.circuitBreaker.recordSuccess(permit);
      }
      throw error;
    }
  }

  public circuitSnapshots(): readonly ExternalLlmCircuitSnapshot[] {
    return this.circuitBreaker.snapshots();
  }

  private async executeWithRetries<T>(input: ExternalLlmExecuteInput<T>): Promise<T> {
    let transportRetries = 0;

    while (true) {
      this.assertCallerActive(input);
      const callNumber = input.context.budget.reserve(input.provider, input.context.requestId);
      const attemptKind = this.attemptKind(input.responseAttempt, transportRetries);
      input.context.progress?.({
        stage: "upstream_attempt_started",
        attempt: input.responseAttempt
      });
      const startedAt = this.now();
      const result = await this.callOnce(input, callNumber);

      if (result.kind === "response") {
        if (result.response.ok) {
          this.telemetry({
            event: "external_llm_attempt",
            requestId: input.context.requestId,
            provider: input.provider,
            model: input.model,
            callNumber,
            responseAttempt: input.responseAttempt,
            attemptKind,
            outcome: "success",
            elapsedMs: Math.max(0, this.now() - startedAt),
            retryable: false
          });
          input.context.progress?.({
            stage: "upstream_response_received",
            attempt: input.responseAttempt
          });
          return result.value as T;
        }

        const providerDetails = await this.readProviderErrorDetails(result.response);
        const retryable = this.isRetryableHttpStatus(result.response.status);
        const retryDelayMs = this.retryDelayMs(result.response, transportRetries);
        const error = new ExternalLlmHttpError(
          input.provider,
          result.response.status,
          `${this.providerLabel(input.provider)} API request failed with status ${result.response.status}.`,
          {
            retryable,
            requestId: input.context.requestId,
            callNumber,
            ...providerDetails,
            ...(retryDelayMs === undefined ? {} : { retryAfterMs: retryDelayMs })
          }
        );
        const elapsedMs = Math.max(0, this.now() - startedAt);

        if (this.shouldRetry(input, transportRetries, retryable, retryDelayMs)) {
          this.recordRetry(input, callNumber, attemptKind, elapsedMs, error, retryDelayMs);
          transportRetries += 1;
          await this.waitBeforeRetry(input, retryDelayMs);
          continue;
        }

        this.recordHttpFailure(input, callNumber, attemptKind, elapsedMs, error);
        throw error;
      }

      const retryDelayMs = this.exponentialDelayMs(transportRetries);
      if (this.shouldRetry(input, transportRetries, result.error.details.retryable, retryDelayMs)) {
        this.recordRetry(input, callNumber, attemptKind, result.elapsedMs, result.error, retryDelayMs);
        transportRetries += 1;
        await this.waitBeforeRetry(input, retryDelayMs);
        continue;
      }

      this.recordExecutionFailure(input, callNumber, attemptKind, result);
      throw result.error;
    }
  }

  private async callOnce(
    input: ExternalLlmExecuteInput<unknown>,
    callNumber: number
  ): Promise<AttemptResponse<unknown> | AttemptFailure> {
    const startedAt = this.now();
    const timeoutMs = Math.min(this.policy.attemptTimeoutMs, input.context.budget.remainingMs());
    if (timeoutMs <= 0) {
      return {
        kind: "failure",
        error: new ExternalLlmExecutionError(
          input.provider,
          "External LLM request deadline was exceeded.",
          {
            kind: "deadline_exceeded",
            retryable: false,
            requestId: input.context.requestId,
            callNumber
          }
        ),
        elapsedMs: 0
      };
    }

    const controller = new AbortController();
    let attemptTimedOut = false;
    const abortFromCaller = (): void => controller.abort(input.context.signal.reason);
    input.context.signal.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      attemptTimedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await input.operation(controller.signal);
      if (!response.ok || input.consumeResponse === undefined) {
        return { kind: "response", response, value: response };
      }
      const value = await input.consumeResponse(response, controller.signal);
      return { kind: "response", response, value };
    } catch (cause) {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      if (input.context.signal.aborted) {
        return {
          kind: "failure",
          error: new ExternalLlmExecutionError(
            input.provider,
            "External LLM request was cancelled by the caller.",
            {
              kind: "cancelled",
              retryable: false,
              requestId: input.context.requestId,
              callNumber
            }
          ),
          elapsedMs
        };
      }

      if (attemptTimedOut) {
        return {
          kind: "failure",
          error: new ExternalLlmExecutionError(
            input.provider,
            `External LLM attempt timed out after ${timeoutMs} milliseconds.`,
            {
              kind: "timeout",
              retryable: true,
              requestId: input.context.requestId,
              callNumber
            }
          ),
          elapsedMs
        };
      }

      const networkCode = this.networkCode(cause);
      const retryable = this.isRetryableNetworkFailure(cause, networkCode);
      return {
        kind: "failure",
        error: new ExternalLlmExecutionError(
          input.provider,
          "External LLM request failed before receiving a response.",
          {
            kind: "network",
            retryable,
            requestId: input.context.requestId,
            callNumber,
            ...(networkCode ? { networkCode } : {})
          }
        ),
        elapsedMs
      };
    } finally {
      clearTimeout(timer);
      input.context.signal.removeEventListener("abort", abortFromCaller);
    }
  }

  private assertCallerActive(input: ExternalLlmExecuteInput<unknown>): void {
    if (!input.context.signal.aborted) {
      return;
    }

    throw new ExternalLlmExecutionError(
      input.provider,
      "External LLM request was cancelled by the caller.",
      {
        kind: "cancelled",
        retryable: false,
        requestId: input.context.requestId
      }
    );
  }

  private shouldRetry(
    input: ExternalLlmExecuteInput<unknown>,
    transportRetries: number,
    retryable: boolean,
    retryDelayMs: number
  ): boolean {
    return retryable &&
      transportRetries < this.policy.maxTransportRetries &&
      input.context.budget.canStartAfter(retryDelayMs);
  }

  private async waitBeforeRetry(input: ExternalLlmExecuteInput<unknown>, retryDelayMs: number): Promise<void> {
    try {
      await this.sleep(retryDelayMs, input.context.signal);
    } catch (cause) {
      if (input.context.signal.aborted) {
        throw new ExternalLlmExecutionError(
          input.provider,
          "External LLM request was cancelled by the caller.",
          {
            kind: "cancelled",
            retryable: false,
            requestId: input.context.requestId
          }
        );
      }
      throw cause;
    }
  }

  private retryDelayMs(response: Response, transportRetries: number): number {
    const retryAfter = this.headerValue(response, "retry-after");
    const parsed = retryAfter ? this.parseRetryAfter(retryAfter) : undefined;
    return parsed ?? this.exponentialDelayMs(transportRetries);
  }

  private exponentialDelayMs(transportRetries: number): number {
    const base = this.policy.retryBaseDelayMs * (2 ** transportRetries);
    return Math.round(base * (1 + (Math.max(0, Math.min(1, this.random())) * 0.3)));
  }

  private parseRetryAfter(value: string): number | undefined {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }

    const date = Date.parse(value);
    if (!Number.isFinite(date)) {
      return undefined;
    }

    return Math.max(0, date - this.now());
  }

  private async readProviderErrorDetails(response: Response): Promise<SafeProviderErrorDetails> {
    if (typeof response.text !== "function") {
      return {};
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return {};
    }

    try {
      const parsed = JSON.parse(text) as ProviderErrorBody;
      const providerStatus = typeof parsed.error?.status === "string"
        ? parsed.error.status.slice(0, 80)
        : undefined;
      const providerMessage = typeof parsed.error?.message === "string"
        ? this.normalizeProviderMessage(parsed.error.message)
        : undefined;
      return {
        ...(providerStatus ? { providerStatus } : {}),
        ...(providerMessage ? { providerMessage } : {})
      };
    } catch {
      return {};
    }
  }

  private normalizeProviderMessage(value: string): string | undefined {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return normalized ? normalized.slice(0, 500) : undefined;
  }

  private headerValue(response: Response, name: string): string | undefined {
    const headers = response.headers as Headers | undefined;
    if (!headers || typeof headers.get !== "function") {
      return undefined;
    }

    return headers.get(name) ?? undefined;
  }

  private isRetryableHttpStatus(status: number): boolean {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private networkCode(error: unknown): string | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth += 1) {
      if (!this.isRecord(current)) {
        return undefined;
      }
      const code = current.code;
      if (typeof code === "string" && code.trim()) {
        return code.trim().toUpperCase();
      }
      current = current.cause;
    }
    return undefined;
  }

  private isRetryableNetworkFailure(error: unknown, code: string | undefined): boolean {
    if (code) {
      return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
    }

    return error instanceof TypeError;
  }

  private attemptKind(responseAttempt: number, transportRetries: number): ExternalLlmAttemptKind {
    if (transportRetries > 0) {
      return "transport_retry";
    }
    return responseAttempt > 1 ? "response_repair" : "initial";
  }

  private recordRetry(
    input: ExternalLlmExecuteInput<unknown>,
    callNumber: number,
    attemptKind: ExternalLlmAttemptKind,
    elapsedMs: number,
    error: ExternalLlmHttpError | ExternalLlmExecutionError,
    retryDelayMs: number
  ): void {
    input.context.progress?.({
      stage: "retry_scheduled",
      attempt: input.responseAttempt,
      retryDelayMs
    });
    this.telemetry({
      event: "external_llm_attempt",
      requestId: input.context.requestId,
      provider: input.provider,
      model: input.model,
      callNumber,
      responseAttempt: input.responseAttempt,
      attemptKind,
      outcome: "retry_scheduled",
      elapsedMs,
      retryable: true,
      failureKind: error.details.kind,
      ...(error instanceof ExternalLlmHttpError ? { httpStatus: error.status } : {}),
      ...(error.details.providerStatus ? { providerStatus: error.details.providerStatus } : {}),
      ...(error.details.networkCode ? { networkCode: error.details.networkCode } : {}),
      retryDelayMs
    });
  }

  private recordHttpFailure(
    input: ExternalLlmExecuteInput<unknown>,
    callNumber: number,
    attemptKind: ExternalLlmAttemptKind,
    elapsedMs: number,
    error: ExternalLlmHttpError
  ): void {
    this.telemetry({
      event: "external_llm_attempt",
      requestId: input.context.requestId,
      provider: input.provider,
      model: input.model,
      callNumber,
      responseAttempt: input.responseAttempt,
      attemptKind,
      outcome: "failure",
      elapsedMs,
      retryable: error.details.retryable,
      failureKind: "http",
      httpStatus: error.status,
      ...(error.details.providerStatus ? { providerStatus: error.details.providerStatus } : {})
    });
  }

  private recordExecutionFailure(
    input: ExternalLlmExecuteInput<unknown>,
    callNumber: number,
    attemptKind: ExternalLlmAttemptKind,
    failure: AttemptFailure
  ): void {
    this.telemetry({
      event: "external_llm_attempt",
      requestId: input.context.requestId,
      provider: input.provider,
      model: input.model,
      callNumber,
      responseAttempt: input.responseAttempt,
      attemptKind,
      outcome: "failure",
      elapsedMs: failure.elapsedMs,
      retryable: failure.error.details.retryable,
      failureKind: failure.error.details.kind,
      ...(failure.error.details.networkCode ? { networkCode: failure.error.details.networkCode } : {})
    });
  }

  private providerLabel(provider: ExternalLlmProvider): string {
    return provider === "gemini" ? "Gemini" : "OpenAI";
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
