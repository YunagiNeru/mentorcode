export const SKILL_SELECTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    selectedIds: {
      type: "array",
      maxItems: 4,
      items: { type: "string" }
    }
  },
  required: ["selectedIds"],
  additionalProperties: false
} as const;
