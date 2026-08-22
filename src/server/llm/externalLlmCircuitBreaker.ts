import { ExternalLlmExecutionError, type ExternalLlmProvider } from "./externalLlmError";

export type ExternalLlmCircuitState = "closed" | "open" | "half_open";

export interface ExternalLlmCircuitBreakerPolicy {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export interface ExternalLlmCircuitPermit {
  readonly key: string;
  readonly state: "closed" | "half_open";
}

export interface ExternalLlmCircuitSnapshot {
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  readonly state: ExternalLlmCircuitState;
  readonly consecutiveFailures: number;
  readonly retryAfterMs: number;
}

interface CircuitEntry {
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  consecutiveFailures: number;
  openUntil: number;
  halfOpenProbeActive: boolean;
}

export class ExternalLlmCircuitBreaker {
  private readonly entries = new Map<string, CircuitEntry>();

  public constructor(
    private readonly policy: ExternalLlmCircuitBreakerPolicy,
    private readonly now: () => number = Date.now
  ) {}

  public acquire(provider: ExternalLlmProvider, model: string, requestId: string): ExternalLlmCircuitPermit {
    const key = this.key(provider, model);
    const entry = this.entries.get(key);
    if (!entry || entry.openUntil === 0) {
      return { key, state: "closed" };
    }

    const remainingOpenMs = entry.openUntil - this.now();
    if (remainingOpenMs > 0 || entry.halfOpenProbeActive) {
      throw new ExternalLlmExecutionError(
        provider,
        "External LLM circuit is open.",
        {
          kind: "circuit_open",
          retryable: true,
          requestId,
          retryAfterMs: Math.max(0, remainingOpenMs)
        }
      );
    }

    entry.halfOpenProbeActive = true;
    return { key, state: "half_open" };
  }

  public recordSuccess(permit: ExternalLlmCircuitPermit): void {
    this.entries.delete(permit.key);
  }

  public recordFailure(
    permit: ExternalLlmCircuitPermit,
    provider: ExternalLlmProvider,
    model: string,
    retryable: boolean
  ): void {
    if (!retryable) {
      this.recordSuccess(permit);
      return;
    }

    const entry = this.entries.get(permit.key) ?? {
      provider,
      model,
      consecutiveFailures: 0,
      openUntil: 0,
      halfOpenProbeActive: false
    };
    entry.consecutiveFailures += 1;
    entry.halfOpenProbeActive = false;

    if (permit.state === "half_open" || entry.consecutiveFailures >= this.policy.failureThreshold) {
      entry.openUntil = this.now() + this.policy.openMs;
    }

    this.entries.set(permit.key, entry);
  }

  public snapshots(): readonly ExternalLlmCircuitSnapshot[] {
    const now = this.now();
    return [...this.entries.values()].map((entry) => {
      const retryAfterMs = Math.max(0, entry.openUntil - now);
      const state: ExternalLlmCircuitState = entry.openUntil === 0
        ? "closed"
        : retryAfterMs > 0
          ? "open"
          : "half_open";
      return {
        provider: entry.provider,
        model: entry.model,
        state,
        consecutiveFailures: entry.consecutiveFailures,
        retryAfterMs
      };
    });
  }

  private key(provider: ExternalLlmProvider, model: string): string {
    return `${provider}:${model}`;
  }
}
