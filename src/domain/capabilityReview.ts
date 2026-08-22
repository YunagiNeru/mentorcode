export const CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION = "mentorcode.capability_review_request.v1";
export const CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION = "mentorcode.capability_review_result.v1";
export const CAPABILITY_REVIEW_SCHEMA_VERSION = "mentorcode.capability_review.v1";

export type CapabilityKind = "skill" | "mcp";

export interface CapabilityReviewRequest {
  readonly schemaVersion: typeof CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION;
  readonly approved: true;
  readonly revision: string;
  readonly kind: CapabilityKind;
  readonly identifier: string;
  readonly source: string;
  readonly content: string;
  readonly warnings: readonly string[];
}

export interface CapabilityReview {
  readonly schema_version: typeof CAPABILITY_REVIEW_SCHEMA_VERSION;
  readonly summary: string;
  readonly capabilities: readonly string[];
  readonly risks: readonly string[];
  readonly data_access: readonly string[];
}

export interface CapabilityReviewResult {
  readonly schemaVersion: typeof CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION;
  readonly revision: string;
  readonly review: CapabilityReview;
  readonly modelId: string;
  readonly reviewedAt: string;
}

export interface LocalCapabilityAudit {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly model: "1-Bit Bonsai 1.7B";
}

export function isCapabilityReviewRequest(value: unknown): value is CapabilityReviewRequest {
  return isRecord(value) &&
    value.schemaVersion === CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION &&
    value.approved === true &&
    (value.kind === "skill" || value.kind === "mcp") &&
    typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision) &&
    typeof value.identifier === "string" && value.identifier.length > 0 && value.identifier.length <= 256 &&
    typeof value.source === "string" && value.source.length > 0 && value.source.length <= 2048 &&
    typeof value.content === "string" && Buffer.byteLength(value.content, "utf8") <= 96 * 1024 &&
    Array.isArray(value.warnings) && value.warnings.length <= 16 &&
    value.warnings.every((warning) => typeof warning === "string" && warning.length <= 500);
}

export function parseCapabilityReview(value: unknown): CapabilityReview {
  if (!isRecord(value) || value.schema_version !== CAPABILITY_REVIEW_SCHEMA_VERSION) {
    throw new Error("Capability review response is malformed.");
  }
  const summary = normalized(value.summary, 360);
  return {
    schema_version: CAPABILITY_REVIEW_SCHEMA_VERSION,
    summary,
    capabilities: stringList(value.capabilities, 8, 240),
    risks: stringList(value.risks, 8, 240),
    data_access: stringList(value.data_access, 8, 240)
  };
}

function stringList(value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error("Capability review list is malformed.");
  }
  const result = value.map((item) => normalized(item, maxLength));
  if (new Set(result).size !== result.length) {
    throw new Error("Capability review list contains duplicates.");
  }
  return result;
}

function normalized(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error("Capability review text is malformed.");
  }
  const result = value.replace(/\s+/g, " ").trim();
  if (!result || result.length > maxLength) {
    throw new Error("Capability review text is outside the allowed length.");
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
