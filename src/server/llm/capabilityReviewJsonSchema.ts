import { CAPABILITY_REVIEW_SCHEMA_VERSION } from "../../domain/capabilityReview";

export const CAPABILITY_REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    schema_version: { type: "string", enum: [CAPABILITY_REVIEW_SCHEMA_VERSION] },
    summary: { type: "string" },
    capabilities: { type: "array", maxItems: 8, items: { type: "string" } },
    risks: { type: "array", maxItems: 8, items: { type: "string" } },
    data_access: { type: "array", maxItems: 8, items: { type: "string" } }
  },
  required: ["schema_version", "summary", "capabilities", "risks", "data_access"],
  additionalProperties: false
} as const;
