import { describe, expect, it } from "vitest";
import { ExternalLlmCircuitBreaker } from "../src/server/llm/externalLlmCircuitBreaker";

describe("ExternalLlmCircuitBreaker", () => {
  it("opens after consecutive retryable failures and permits one recovery probe", () => {
    let now = 1_000;
    const breaker = new ExternalLlmCircuitBreaker({
      failureThreshold: 2,
      openMs: 30_000
    }, () => now);

    const first = breaker.acquire("gemini", "primary", "request-one");
    breaker.recordFailure(first, "gemini", "primary", true);
    const second = breaker.acquire("gemini", "primary", "request-two");
    breaker.recordFailure(second, "gemini", "primary", true);

    expect(() => breaker.acquire("gemini", "primary", "request-three")).toThrow("External LLM circuit is open.");
    expect(breaker.snapshots()).toEqual([{
      provider: "gemini",
      model: "primary",
      state: "open",
      consecutiveFailures: 2,
      retryAfterMs: 30_000
    }]);

    now += 30_000;
    const probe = breaker.acquire("gemini", "primary", "request-four");
    expect(probe.state).toBe("half_open");
    expect(() => breaker.acquire("gemini", "primary", "request-five")).toThrow("External LLM circuit is open.");
    breaker.recordSuccess(probe);
    expect(breaker.snapshots()).toEqual([]);
  });

  it("does not count permanent failures as provider availability failures", () => {
    const breaker = new ExternalLlmCircuitBreaker({
      failureThreshold: 1,
      openMs: 30_000
    });

    const permit = breaker.acquire("gemini", "primary", "request-one");
    breaker.recordFailure(permit, "gemini", "primary", false);

    expect(breaker.acquire("gemini", "primary", "request-two").state).toBe("closed");
    expect(breaker.snapshots()).toEqual([]);
  });
});
