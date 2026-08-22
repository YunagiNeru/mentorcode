import { describe, expect, it } from "vitest";
import {
  CustomInstructionReviewParser,
  CustomInstructionReviewValidationError,
  type CustomInstructionReviewValidationFailureCode
} from "../src/server/llm/customInstructionReviewParser";
import { validCustomInstructionReview } from "./fixtures/customInstructionReview";

function expectFailureCode(
  operation: () => void,
  code: CustomInstructionReviewValidationFailureCode
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CustomInstructionReviewValidationError);
  expect((caught as CustomInstructionReviewValidationError).code).toBe(code);
}

describe("CustomInstructionReviewParser", () => {
  it("accepts and normalizes a concise natural-language review", () => {
    const review = validCustomInstructionReview();
    const parsed = new CustomInstructionReviewParser().parse(JSON.stringify({
      ...review,
      summary: `  ${review.summary}\n`,
      comments: review.comments.map((comment) => `${comment}\n`)
    }));

    expect(parsed).toEqual(review);
  });

  it("accepts an empty comment list when no material problem exists", () => {
    const parsed = new CustomInstructionReviewParser().parse(JSON.stringify({
      ...validCustomInstructionReview(),
      summary: "大きな問題は見当たりません。",
      comments: []
    }));

    expect(parsed.comments).toEqual([]);
  });

  it("rejects obsolete score and rubric fields", () => {
    expectFailureCode(() => new CustomInstructionReviewParser().parse(JSON.stringify({
      ...validCustomInstructionReview(),
      score: 90,
      rubric: []
    })), "unexpected_property");
  });

  it("rejects more than four or duplicate comments", () => {
    const parser = new CustomInstructionReviewParser();
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...validCustomInstructionReview(),
      comments: ["一", "二", "三", "四", "五"]
    })), "comments_too_many");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...validCustomInstructionReview(),
      comments: ["同じ指摘です。", "同じ指摘です。"]
    })), "duplicate_comment");
  });

  it("rejects verbose summaries and comments", () => {
    const parser = new CustomInstructionReviewParser();
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...validCustomInstructionReview(),
      summary: "あ".repeat(241)
    })), "summary_too_long");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...validCustomInstructionReview(),
      comments: ["あ".repeat(361)]
    })), "comment_too_long");
  });

  it("classifies every remaining repairable validation boundary without response text", () => {
    const parser = new CustomInstructionReviewParser();
    const review = validCustomInstructionReview();

    expectFailureCode(() => parser.parse("not-json"), "invalid_json");
    expectFailureCode(() => parser.parse("[]"), "not_object");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      schema_version: "unsupported"
    })), "unsupported_schema_version");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      summary: 1
    })), "summary_not_string");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      summary: "  "
    })), "summary_empty");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      comments: "指摘"
    })), "comments_not_array");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      comments: [1]
    })), "comment_not_string");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      comments: ["  "]
    })), "comment_empty");
    expectFailureCode(() => parser.parse(JSON.stringify({
      ...review,
      comments: [
        "一".repeat(301),
        "二".repeat(301),
        "三".repeat(301),
        "四".repeat(301)
      ]
    })), "total_comments_too_long");
  });
});
