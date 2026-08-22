import type { ExternalLlmCircuitSnapshot } from "./externalLlmCircuitBreaker";
import type { ExternalLlmProvider } from "./externalLlmError";
import type { ExternalLlmAttemptEvent } from "./externalLlmResilience";

export interface ExternalLlmAvailabilityCounter {
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly retriesScheduled: number;
  readonly totalElapsedMs: number;
  readonly lastEventAt: string;
}

export interface ExternalLlmAvailabilitySnapshot {
  readonly generatedAt: string;
  readonly counters: readonly ExternalLlmAvailabilityCounter[];
  readonly circuits: readonly ExternalLlmCircuitSnapshot[];
}

interface MutableAvailabilityCounter {
  readonly provider: ExternalLlmProvider;
  readonly model: string;
  calls: number;
  successes: number;
  failures: number;
  retriesScheduled: number;
  totalElapsedMs: number;
  lastEventAt: string;
}

export class ExternalLlmAvailabilityMonitor {
  private readonly counters = new Map<string, MutableAvailabilityCounter>();

  public constructor(private readonly now: () => number = Date.now) {}

  public record(event: ExternalLlmAttemptEvent): void {
    const key = `${event.provider}:${event.model}`;
    const counter = this.counters.get(key) ?? {
      provider: event.provider,
      model: event.model,
      calls: 0,
      successes: 0,
      failures: 0,
      retriesScheduled: 0,
      totalElapsedMs: 0,
      lastEventAt: new Date(this.now()).toISOString()
    };

    counter.calls += 1;
    counter.successes += event.outcome === "success" ? 1 : 0;
    counter.failures += event.outcome === "failure" ? 1 : 0;
    counter.retriesScheduled += event.outcome === "retry_scheduled" ? 1 : 0;
    counter.totalElapsedMs += Math.max(0, event.elapsedMs);
    counter.lastEventAt = new Date(this.now()).toISOString();
    this.counters.set(key, counter);
  }

  public snapshot(circuits: readonly ExternalLlmCircuitSnapshot[]): ExternalLlmAvailabilitySnapshot {
    return {
      generatedAt: new Date(this.now()).toISOString(),
      counters: [...this.counters.values()]
        .map((counter) => ({ ...counter }))
        .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)),
      circuits: [...circuits]
    };
  }
}
