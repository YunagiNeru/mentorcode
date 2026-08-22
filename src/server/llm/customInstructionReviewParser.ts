import {
  CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION,
  type CustomInstructionLlmReview
} from "../../domain/customInstructionReview";

export class CustomInstructionReviewResponseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CustomInstructionReviewResponseError";
  }
}

export type CustomInstructionReviewValidationFailureCode =
  | "invalid_json"
  | "not_object"
  | "unexpected_property"
  | "unsupported_schema_version"
  | "summary_not_string"
  | "summary_empty"
  | "summary_too_long"
  | "comments_not_array"
  | "comments_too_many"
  | "comment_not_string"
  | "comment_empty"
  | "comment_too_long"
  | "duplicate_comment"
  | "total_comments_too_long";

export class CustomInstructionReviewValidationError extends Error {
  public constructor(
    public readonly code: CustomInstructionReviewValidationFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CustomInstructionReviewValidationError";
  }
}

export class CustomInstructionReviewParser {
  private static readonly maxSummaryLength = 240;
  private static readonly maxCommentLength = 360;
  private static readonly maxCommentCount = 4;
  private static readonly maxTotalCommentLength = 1_200;

  public parse(text: string): CustomInstructionLlmReview {
    const value = this.parseJson(text);
    if (!this.isRecord(value)) {
      throw new CustomInstructionReviewValidationError(
        "not_object",
        "Custom instruction review response must be a JSON object."
      );
    }

    const allowedKeys = new Set(["schema_version", "summary", "comments"]);
    const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unexpectedKey) {
      throw new CustomInstructionReviewValidationError(
        "unexpected_property",
        "Custom instruction review response contains an unexpected property."
      );
    }
    if (value.schema_version !== CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION) {
      throw new CustomInstructionReviewValidationError(
        "unsupported_schema_version",
        "Custom instruction review schema version is unsupported."
      );
    }

    const summary = this.normalizedText(
      value.summary,
      "summary",
      CustomInstructionReviewParser.maxSummaryLength,
      "summary_not_string",
      "summary_empty",
      "summary_too_long"
    );
    if (!Array.isArray(value.comments)) {
      throw new CustomInstructionReviewValidationError(
        "comments_not_array",
        "Custom instruction review comments must be an array."
      );
    }
    if (value.comments.length > CustomInstructionReviewParser.maxCommentCount) {
      throw new CustomInstructionReviewValidationError(
        "comments_too_many",
        "Custom instruction review comments must contain at most four items."
      );
    }
    const comments = value.comments.map((comment, index) => (
      this.normalizedText(
        comment,
        `comments[${index}]`,
        CustomInstructionReviewParser.maxCommentLength,
        "comment_not_string",
        "comment_empty",
        "comment_too_long"
      )
    ));
    if (new Set(comments).size !== comments.length) {
      throw new CustomInstructionReviewValidationError(
        "duplicate_comment",
        "Custom instruction review comments must not contain duplicates."
      );
    }
    if (comments.reduce((total, comment) => total + comment.length, 0) > CustomInstructionReviewParser.maxTotalCommentLength) {
      throw new CustomInstructionReviewValidationError(
        "total_comments_too_long",
        "Custom instruction review comments are too long in total."
      );
    }

    return {
      schema_version: CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION,
      summary,
      comments
    };
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new CustomInstructionReviewValidationError(
        "invalid_json",
        "Custom instruction review response must be valid JSON.",
        { cause }
      );
    }
  }

  private normalizedText(
    value: unknown,
    field: string,
    maxLength: number,
    typeFailureCode: CustomInstructionReviewValidationFailureCode,
    emptyFailureCode: CustomInstructionReviewValidationFailureCode,
    lengthFailureCode: CustomInstructionReviewValidationFailureCode
  ): string {
    if (typeof value !== "string") {
      throw new CustomInstructionReviewValidationError(
        typeFailureCode,
        `Custom instruction review ${field} must be a string.`
      );
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      throw new CustomInstructionReviewValidationError(
        emptyFailureCode,
        `Custom instruction review ${field} must not be empty.`
      );
    }
    if (normalized.length > maxLength) {
      throw new CustomInstructionReviewValidationError(
        lengthFailureCode,
        `Custom instruction review ${field} must contain at most ${maxLength} characters.`
      );
    }
    return normalized;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
