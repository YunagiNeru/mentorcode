import { describe, expect, it } from "vitest";
import { ExternalLlmAvailabilityMonitor } from "../src/server/llm/externalLlmAvailabilityMonitor";
import type { ExternalLlmAttemptEvent } from "../src/server/llm/externalLlmResilience";

function attempt(outcome: ExternalLlmAttemptEvent["outcome"], elapsedMs: number): ExternalLlmAttemptEvent {
  return {
    event: "external_llm_attempt",
    requestId: "req_abcdefghijklmnopabcdefghijklmnop",
    provider: "gemini",
    model: "primary-model",
    callNumber: 1,
    responseAttempt: 1,
    attemptKind: "initial",
    outcome,
    elapsedMs,
    retryable: outcome !== "success"
  };
}

describe("ExternalLlmAvailabilityMonitor", () => {
  it("aggregates availability without retaining request IDs or provider messages", () => {
    const monitor = new ExternalLlmAvailabilityMonitor(() => Date.parse("2026-07-14T00:00:00.000Z"));
    monitor.record(attempt("retry_scheduled", 120));
    monitor.record(attempt("success", 80));

    const snapshot = monitor.snapshot([]);

    expect(snapshot.counters).toEqual([{
      provider: "gemini",
      model: "primary-model",
      calls: 2,
      successes: 1,
      failures: 0,
      retriesScheduled: 1,
      totalElapsedMs: 200,
      lastEventAt: "2026-07-14T00:00:00.000Z"
    }]);
    expect(JSON.stringify(snapshot)).not.toContain("req_abcdefghijklmnopabcdefghijklmnop");
  });
});
