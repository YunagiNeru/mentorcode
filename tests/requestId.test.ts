import { describe, expect, it } from "vitest";
import { createMentorRequestId, isMentorRequestId } from "../src/domain/requestId";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";

describe("mentor request IDs", () => {
  it("creates fixed-length identifiers that remain stable through privacy logging", () => {
    const first = createMentorRequestId();
    const second = createMentorRequestId();

    expect(first).toMatch(/^req_[a-p]{32}$/);
    expect(second).toMatch(/^req_[a-p]{32}$/);
    expect(first).not.toBe(second);
    expect(isMentorRequestId(first)).toBe(true);
    const logResult = new PrivacyGuard().analyzeFile({
      path: "logs/request-id.txt",
      content: `requestId=${first}`,
      sizeBytes: first.length + 10
    });
    expect(logResult.maskedContent).toContain(first);
  });

  it("rejects UUIDs and user-controlled log fragments", () => {
    expect(isMentorRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
    expect(isMentorRequestId("req_../../unsafe")).toBe(false);
  });
});
