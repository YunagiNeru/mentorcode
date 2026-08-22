import { CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION } from "../../domain/customInstructionReview";

type JsonSchema = Record<string, unknown>;

export const CUSTOM_INSTRUCTION_REVIEW_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schema_version: {
      type: "string",
      enum: [CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION],
      description: "指定されたレビューSchemaバージョンを変更せず返す。"
    },
    summary: {
      type: "string",
      description: "レビュー全体の要約。日本語1〜2文、1〜240文字。"
    },
    comments: {
      type: "array",
      description: "重要度順の指摘。重要な問題がなければ空配列。最大4件。",
      maxItems: 4,
      items: {
        type: "string",
        description: "日本語の自然な一段落。1〜360文字で、他の項目と重複させない。"
      }
    }
  },
  required: ["schema_version", "summary", "comments"],
  additionalProperties: false
};
