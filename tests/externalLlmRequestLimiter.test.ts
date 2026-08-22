import { describe, expect, it } from "vitest";
import { ExternalLlmRequestLimiter } from "../src/server/llm/externalLlmRequestLimiter";

describe("ExternalLlmRequestLimiter", () => {
  it("rejects excess work and releases capacity idempotently", () => {
    const limiter = new ExternalLlmRequestLimiter(1);
    const release = limiter.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeUndefined();

    release?.();
    release?.();
    expect(limiter.tryAcquire()).toBeTypeOf("function");
  });
});
