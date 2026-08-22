import { createHash } from "node:crypto";
import type { FileGuardResult } from "./types";
import { PrivacyGuard } from "./privacy/privacyGuard";

export interface InstructionSafetyPolicy {
  readonly path: string;
  readonly displayName: string;
  readonly maxBytes: number;
}

interface AcceptedInstructionSafetyDecision {
  readonly accepted: true;
  readonly reason: string;
  readonly sourceRevision: string;
  readonly maskedContent: string;
  readonly byteLength: number;
  readonly result: FileGuardResult;
}

interface RejectedInstructionSafetyDecision {
  readonly accepted: false;
  readonly reason: string;
  readonly sourceRevision: string;
  readonly result: FileGuardResult;
}

export type InstructionSafetyDecision =
  | AcceptedInstructionSafetyDecision
  | RejectedInstructionSafetyDecision;

export function instructionRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export class InstructionSafetyAudit {
  public constructor(
    private readonly guard: PrivacyGuard,
    private readonly policy: InstructionSafetyPolicy
  ) {}

  public async sanitize(content: string): Promise<InstructionSafetyDecision> {
    const sourceRevision = instructionRevision(content);
    const byteLength = Buffer.byteLength(content, "utf8");
    const result = await this.guard.analyzeFileAsync({
      path: this.policy.path,
      content,
      sizeBytes: byteLength
    });

    if (byteLength > this.policy.maxBytes) {
      return this.rejected(
        sourceRevision,
        result,
        `${this.policy.displayName} が ${this.policy.maxBytes} バイトを超えています。`
      );
    }

    if (result.blocked || result.excluded || result.maskedContent === undefined) {
      return this.rejected(
        sourceRevision,
        result,
        result.excludeReason ?? `${this.policy.displayName} に外部送信できない秘密情報候補があります。`
      );
    }

    const semanticScanRequired = result.maskingEvents.some((event) => (
      event.action === "mask" || event.action === "block"
    ));
    if (semanticScanRequired && result.localLlmReview?.status !== "completed") {
      return this.rejected(
        sourceRevision,
        result,
        `${this.policy.displayName} の秘匿情報候補を検出しましたが、ローカルLLMによる安全確認を完了できませんでした。外部送信を停止しました。`
      );
    }

    return {
      accepted: true,
      reason: semanticScanRequired
        ? `${this.policy.displayName} の秘匿情報候補をマスクし、ローカルLLMによる安全確認が完了しました。`
        : `${this.policy.displayName} の機械的な秘匿情報確認が完了しました。`,
      sourceRevision,
      maskedContent: result.maskedContent,
      byteLength: Buffer.byteLength(result.maskedContent, "utf8"),
      result
    };
  }

  private rejected(
    sourceRevision: string,
    result: FileGuardResult,
    reason: string
  ): InstructionSafetyDecision {
    return {
      accepted: false,
      reason,
      sourceRevision,
      result
    };
  }
}
