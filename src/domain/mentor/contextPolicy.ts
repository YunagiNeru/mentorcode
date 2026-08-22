import type { FileCandidate, MentorContextSource } from "../types";

export interface MentorContextLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface MentorContextBudgetExclusion {
  readonly path: string;
  readonly reason: string;
  readonly contextSource?: MentorContextSource;
  readonly sourceSizeBytes?: number;
  readonly includedSizeBytes?: number;
  readonly contentComplete?: boolean;
}

export interface MentorContextBudgetResult {
  readonly candidates: readonly FileCandidate[];
  readonly exclusions: readonly MentorContextBudgetExclusion[];
}

const MAX_MENTOR_CONTEXT_FILES = 48;
const MAX_MENTOR_FILE_BYTES = 120_000;
const MAX_MENTOR_CONTEXT_BYTES = 240_000;

export class MentorContextPolicy {
  public limits(configuredMaxFiles: number, configuredMaxFileBytes: number): MentorContextLimits {
    return {
      maxFiles: Math.max(1, Math.min(configuredMaxFiles, MAX_MENTOR_CONTEXT_FILES)),
      maxFileBytes: Math.max(1024, Math.min(configuredMaxFileBytes, MAX_MENTOR_FILE_BYTES)),
      maxTotalBytes: MAX_MENTOR_CONTEXT_BYTES
    };
  }

  public applyTotalBudget(
    candidates: readonly FileCandidate[],
    maxTotalBytes: number
  ): MentorContextBudgetResult {
    const selected: FileCandidate[] = [];
    const exclusions: MentorContextBudgetExclusion[] = [];
    let usedBytes = 0;

    for (const candidate of candidates) {
      const includedBytes = candidate.includedSizeBytes ?? new TextEncoder().encode(candidate.content).byteLength;
      if (usedBytes + includedBytes <= maxTotalBytes) {
        selected.push(candidate);
        usedBytes += includedBytes;
        continue;
      }

      exclusions.push({
        path: candidate.path,
        reason: `メンター送信用コンテキストの総量上限 ${maxTotalBytes} bytes を超えるため除外しました`,
        ...(candidate.contextSource ? { contextSource: candidate.contextSource } : {}),
        ...(candidate.sourceSizeBytes === undefined ? {} : { sourceSizeBytes: candidate.sourceSizeBytes }),
        ...(candidate.includedSizeBytes === undefined ? {} : { includedSizeBytes: candidate.includedSizeBytes }),
        contentComplete: false
      });
    }

    return {
      candidates: selected,
      exclusions
    };
  }
}
