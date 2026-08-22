import { afterEach, describe, expect, it, vi } from "vitest";
import type { MentorProgressUpdate } from "../src/domain/mentorProgress";
import type { ContextPackage, MentorRequest } from "../src/domain/types";
import { GeminiClient } from "../src/server/llm/geminiClient";
import {
  createExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor,
  type ExternalLlmAvailabilityPolicy
} from "../src/server/llm/externalLlmResilience";

const policy: ExternalLlmAvailabilityPolicy = {
  maxCalls: 3,
  maxTransportRetries: 0,
  attemptTimeoutMs: 1_000,
  totalTimeoutMs: 2_000,
  retryBaseDelayMs: 1,
  circuitFailureThreshold: 3,
  circuitOpenMs: 30_000
};

const request: MentorRequest = { task: "安全な方針を示してください" };
const contextPackage: ContextPackage = {
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

describe("GeminiClient streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SSEの部分JSONを内部で連結し、検証済み最終応答だけを返す", async () => {
    const expected = {
      title: "ストリーム応答",
      sections: [{ heading: "方針", items: ["安全に処理します。"] }],
      policyWarnings: []
    };
    const serialized = JSON.stringify(expected);
    const midpoint = Math.floor(serialized.length / 2);
    const frames = [serialized.slice(0, midpoint), serialized.slice(midpoint)].map((text) => (
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`
    ));
    const encoded = new TextEncoder().encode(frames.join(""));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17));
        controller.close();
      }
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    }))));
    const progress: MentorProgressUpdate[] = [];
    const controller = new AbortController();
    const executionContext = createExternalLlmExecutionContext(
      policy,
      "request-stream",
      controller.signal,
      Date.now,
      (event) => progress.push(event)
    );
    const client = new GeminiClient({
      apiKey: "test-key",
      model: "test-model",
      resilienceExecutor: new ExternalLlmResilienceExecutor(policy),
      executionContext
    });

    await expect(client.createMentorResponse(request, contextPackage)).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) })
    );
    expect(progress.map((event) => event.stage)).toEqual([
      "upstream_attempt_started",
      "upstream_first_chunk_received",
      "upstream_response_received",
      "response_validating"
    ]);
  });
});
