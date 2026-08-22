import { describe, expect, it } from "vitest";
import { CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA } from "../src/server/llm/customInstructionReviewJsonSchema";

describe("CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA", () => {
  it("expresses only Gemini-supported structural limits and leaves semantic limits to the parser", () => {
    const schema = CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA as {
      readonly additionalProperties?: unknown;
      readonly required?: readonly string[];
      readonly properties?: {
        readonly summary?: Record<string, unknown>;
        readonly comments?: Record<string, unknown> & {
          readonly items?: Record<string, unknown>;
        };
      };
    };

    expect(schema.required).toEqual(["schema_version", "summary", "comments"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.comments?.maxItems).toBe(4);
    expect(schema.properties?.comments?.description).toContain("最大4件");
    expect(schema.properties?.summary?.description).toContain("240文字");
    expect(schema.properties?.summary).not.toHaveProperty("maxLength");
    expect(schema.properties?.comments).not.toHaveProperty("uniqueItems");
    expect(schema.properties?.comments?.items).not.toHaveProperty("maxLength");
  });
});
