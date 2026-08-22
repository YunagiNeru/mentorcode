import type { DetectionFinding, FileCandidate, LocalLlmReview, MaskingEvent } from "../types";

export interface SemanticFileInput extends FileCandidate {
  readonly maskedContent: string;
  readonly findings: readonly DetectionFinding[];
  readonly maskingEvents: readonly MaskingEvent[];
}

export interface SemanticDetectionResult {
  readonly findings: readonly DetectionFinding[];
  readonly review: LocalLlmReview;
}

export interface AsyncSemanticDetector {
  readonly name: string;
  detectFile(file: SemanticFileInput): Promise<SemanticDetectionResult>;
}
