import { describe, expect, it } from "vitest";
import {
  CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION,
  CAPABILITY_REVIEW_SCHEMA_VERSION,
  isCapabilityReviewRequest,
  parseCapabilityReview
} from "../src/domain/capabilityReview";

describe("capability review contract", () => {
  it("accepts a bounded approved audit request", () => {
    expect(isCapabilityReviewRequest({
      schemaVersion: CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION,
      approved: true,
      revision: "a".repeat(64),
      kind: "skill",
      identifier: "example",
      source: "https://example.test/repository.git",
      content: "safe content",
      warnings: []
    })).toBe(true);
  });

  it("rejects a review request without explicit approval", () => {
    expect(isCapabilityReviewRequest({
      schemaVersion: CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION,
      approved: false,
      revision: "a".repeat(64),
      kind: "mcp",
      identifier: "example",
      source: "https://example.test/mcp",
      content: "{}",
      warnings: []
    })).toBe(false);
  });

  it("parses the structured explanation", () => {
    expect(parseCapabilityReview({
      schema_version: CAPABILITY_REVIEW_SCHEMA_VERSION,
      summary: "対象の概要です。",
      capabilities: ["検索"],
      risks: ["外部通信"],
      data_access: ["検索語"]
    })).toMatchObject({ summary: "対象の概要です。", risks: ["外部通信"] });
  });
});
