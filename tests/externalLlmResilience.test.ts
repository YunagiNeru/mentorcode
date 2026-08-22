import { describe, expect, it, vi } from "vitest";
import { ExternalLlmExecutionError, ExternalLlmHttpError } from "../src/server/llm/externalLlmError";
import {
  ExternalLlmResilienceExecutor,
  createExternalLlmExecutionContext,
  type ExternalLlmAttemptEvent,
  type ExternalLlmAvailabilityPolicy
} from "../src/server/llm/externalLlmResilience";

const policy: ExternalLlmAvailabilityPolicy = {
  maxCalls: 3,
  maxTransportRetries: 1,
  attemptTimeoutMs: 30_000,
  totalTimeoutMs: 60_000,
  retryBaseDelayMs: 1_000,
  circuitFailureThreshold: 3,
  circuitOpenMs: 30_000
};

function context(override: Partial<ExternalLlmAvailabilityPolicy> = {}) {
  const controller = new AbortController();
  return {
    controller,
    value: createExternalLlmExecutionContext({ ...policy, ...override }, "request-123", controller.signal)
  };
}

describe("ExternalLlmResilienceExecutor", () => {
  it("retries a transient 503 once and records a bounded successful call sequence", async () => {
    const events: ExternalLlmAttemptEvent[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const operation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          status: "UNAVAILABLE",
          message: "temporary capacity shortage"
        }
      }), {
        status: 503,
        headers: {
          "Content-Type": "application/json"
        }
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const executor = new ExternalLlmResilienceExecutor(policy, {
      random: () => 0,
      sleep,
      telemetry: (event) => events.push(event)
    });

    const result = await executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: context().value,
      operation
    });

    expect(result.status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(events.map((event) => [event.callNumber, event.attemptKind, event.outcome])).toEqual([
      [1, "initial", "retry_scheduled"],
      [2, "transport_retry", "success"]
    ]);
  });

  it("honors Retry-After only when another call remains within the total budget", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const operation = vi.fn().mockResolvedValue(new Response("{}", {
      status: 429,
      headers: {
        "Retry-After": "120"
      }
    }));
    const executor = new ExternalLlmResilienceExecutor(policy, {
      random: () => 0,
      sleep
    });

    await expect(executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: context().value,
      operation
    })).rejects.toMatchObject({
      status: 429,
      details: {
        kind: "http",
        retryable: true,
        retryAfterMs: 120_000
      }
    } satisfies Partial<ExternalLlmHttpError>);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry permanent DNS or TLS failures", async () => {
    const operation = vi.fn().mockRejectedValue(new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate has expired"), {
        code: "CERT_HAS_EXPIRED"
      })
    }));
    const executor = new ExternalLlmResilienceExecutor(policy, {
      sleep: () => Promise.resolve()
    });

    await expect(executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: context().value,
      operation
    })).rejects.toMatchObject({
      details: {
        kind: "network",
        retryable: false,
        networkCode: "CERT_HAS_EXPIRED"
      }
    } satisfies Partial<ExternalLlmExecutionError>);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("shares one total call budget between response repair and transport retry", async () => {
    const shared = context({ maxCalls: 2 });
    const executor = new ExternalLlmResilienceExecutor({ ...policy, maxCalls: 2 }, {
      random: () => 0,
      sleep: () => Promise.resolve()
    });

    await executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: shared.value,
      operation: () => Promise.resolve(new Response("{}", { status: 200 }))
    });
    await executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 2,
      context: shared.value,
      operation: () => Promise.resolve(new Response("{}", { status: 200 }))
    });

    await expect(executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 3,
      context: shared.value,
      operation: () => Promise.resolve(new Response("{}", { status: 200 }))
    })).rejects.toMatchObject({
      details: {
        kind: "call_budget_exhausted",
        retryable: false
      }
    } satisfies Partial<ExternalLlmExecutionError>);
    expect(shared.value.budget.usedCalls()).toBe(2);
  });

  it("does not start a call after caller cancellation", async () => {
    const cancelled = context();
    cancelled.controller.abort();
    const operation = vi.fn();
    const executor = new ExternalLlmResilienceExecutor(policy);

    await expect(executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: cancelled.value,
      operation
    })).rejects.toMatchObject({
      details: {
        kind: "cancelled",
        retryable: false
      }
    } satisfies Partial<ExternalLlmExecutionError>);
    expect(operation).not.toHaveBeenCalled();
  });

  it("classifies an attempt timeout separately from caller cancellation", async () => {
    const shortPolicy: ExternalLlmAvailabilityPolicy = {
      ...policy,
      maxCalls: 1,
      maxTransportRetries: 0,
      attemptTimeoutMs: 5,
      totalTimeoutMs: 50
    };
    const executor = new ExternalLlmResilienceExecutor(shortPolicy);
    const operation = vi.fn((signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    await expect(executor.execute({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: context(shortPolicy).value,
      operation
    })).rejects.toMatchObject({
      details: {
        kind: "timeout",
        retryable: true
      }
    } satisfies Partial<ExternalLlmExecutionError>);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps response body consumption inside the attempt timeout", async () => {
    const shortPolicy: ExternalLlmAvailabilityPolicy = {
      ...policy,
      maxCalls: 1,
      maxTransportRetries: 0,
      attemptTimeoutMs: 5,
      totalTimeoutMs: 50
    };
    const executor = new ExternalLlmResilienceExecutor(shortPolicy);

    await expect(executor.execute<string>({
      provider: "gemini",
      model: "test-model",
      responseAttempt: 1,
      context: context(shortPolicy).value,
      operation: () => Promise.resolve(new Response("{}", { status: 200 })),
      consumeResponse: (_response, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
    })).rejects.toMatchObject({
      details: {
        kind: "timeout",
        retryable: true
      }
    } satisfies Partial<ExternalLlmExecutionError>);
  });
});
