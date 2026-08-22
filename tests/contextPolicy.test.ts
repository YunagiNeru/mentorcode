import { describe, expect, it } from "vitest";
import { MentorContextPolicy } from "../src/domain/mentor/contextPolicy";

describe("MentorContextPolicy", () => {
  it("uses one context limit independent from hint levels", () => {
    const policy = new MentorContextPolicy();

    expect(policy.limits(200, 120_000)).toEqual({
      maxFiles: 48,
      maxFileBytes: 120_000,
      maxTotalBytes: 240_000
    });
    expect(policy.limits(12, 16_000)).toEqual({
      maxFiles: 12,
      maxFileBytes: 16_000,
      maxTotalBytes: 240_000
    });
  });

  it("keeps earlier explicit references and reports later budget exclusions", () => {
    const policy = new MentorContextPolicy();
    const result = policy.applyTotalBudget([
      {
        path: "POLICY.html",
        content: "policy",
        contextSource: "explicit_reference",
        sourceSizeBytes: 6,
        includedSizeBytes: 6,
        contentComplete: true
      },
      {
        path: "src/main.ts",
        content: "main",
        contextSource: "task_discovery",
        sourceSizeBytes: 4,
        includedSizeBytes: 4,
        contentComplete: true
      }
    ], 6);

    expect(result.candidates.map((candidate) => candidate.path)).toEqual(["POLICY.html"]);
    expect(result.exclusions).toEqual([
      expect.objectContaining({
        path: "src/main.ts",
        contextSource: "task_discovery",
        contentComplete: false
      })
    ]);
  });
});
