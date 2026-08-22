import { InstructionSafetyAudit, instructionRevision } from "./instructionSafety";
import { PrivacyGuard } from "./privacy/privacyGuard";
import type { FileGuardResult } from "./types";

export const CUSTOM_INSTRUCTION_DIRECTORY_NAME = ".mentor-code";
export const CUSTOM_INSTRUCTION_FILE_NAME = "AGENTS.md";
export const CUSTOM_INSTRUCTION_MAX_BYTES = 32 * 1024;
export const CUSTOM_INSTRUCTION_SCHEMA_VERSION = "mentorcode.custom_instruction.v1";

export interface CustomInstructionContext {
  readonly schemaVersion: typeof CUSTOM_INSTRUCTION_SCHEMA_VERSION;
  readonly fileName: typeof CUSTOM_INSTRUCTION_FILE_NAME;
  readonly content: string;
  readonly revision: string;
  readonly byteLength: number;
}

export interface CustomInstructionGuardDecision {
  readonly accepted: boolean;
  readonly reason: string;
  readonly result: FileGuardResult;
}

interface AcceptedCustomInstructionSafetyDecision {
  readonly accepted: true;
  readonly reason: string;
  readonly sourceRevision: string;
  readonly context: CustomInstructionContext;
  readonly result: FileGuardResult;
}

interface RejectedCustomInstructionSafetyDecision {
  readonly accepted: false;
  readonly reason: string;
  readonly sourceRevision: string;
  readonly result: FileGuardResult;
}

export type CustomInstructionSafetyDecision =
  | AcceptedCustomInstructionSafetyDecision
  | RejectedCustomInstructionSafetyDecision;

export function customInstructionRevision(content: string): string {
  return instructionRevision(content);
}

export function createCustomInstructionContext(content: string): CustomInstructionContext {
  return {
    schemaVersion: CUSTOM_INSTRUCTION_SCHEMA_VERSION,
    fileName: CUSTOM_INSTRUCTION_FILE_NAME,
    content,
    revision: customInstructionRevision(content),
    byteLength: Buffer.byteLength(content, "utf8")
  };
}

export function isCustomInstructionContext(value: unknown): value is CustomInstructionContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<CustomInstructionContext>;
  return candidate.schemaVersion === CUSTOM_INSTRUCTION_SCHEMA_VERSION &&
    candidate.fileName === CUSTOM_INSTRUCTION_FILE_NAME &&
    typeof candidate.content === "string" &&
    typeof candidate.revision === "string" &&
    candidate.revision === customInstructionRevision(candidate.content) &&
    typeof candidate.byteLength === "number" &&
    candidate.byteLength === Buffer.byteLength(candidate.content, "utf8") &&
    candidate.byteLength <= CUSTOM_INSTRUCTION_MAX_BYTES;
}

export class CustomInstructionGuard {
  public constructor(private readonly guard = new PrivacyGuard()) {}

  public inspect(content: string): CustomInstructionGuardDecision {
    const byteLength = Buffer.byteLength(content, "utf8");
    const result = this.guard.analyzeFile({
      path: `custom-instructions/${CUSTOM_INSTRUCTION_FILE_NAME}`,
      content
    });
    if (byteLength > CUSTOM_INSTRUCTION_MAX_BYTES) {
      return {
        accepted: false,
        reason: `AGENTS.md が ${CUSTOM_INSTRUCTION_MAX_BYTES} バイトを超えています。`,
        result
      };
    }

    const unsafe = result.blocked || result.excluded || result.findings.some((finding) => (
      finding.action === "mask" || finding.action === "block"
    ));
    return {
      accepted: !unsafe,
      reason: unsafe
        ? "AGENTS.md に外部送信できない秘密情報候補があります。"
        : "AGENTS.md の機械的安全確認が完了しました。",
      result
    };
  }
}

export class CustomInstructionSafetyAudit {
  private readonly audit: InstructionSafetyAudit;

  public constructor(guard: PrivacyGuard) {
    this.audit = new InstructionSafetyAudit(guard, {
      path: `custom-instructions/${CUSTOM_INSTRUCTION_FILE_NAME}`,
      displayName: CUSTOM_INSTRUCTION_FILE_NAME,
      maxBytes: CUSTOM_INSTRUCTION_MAX_BYTES
    });
  }

  public async sanitize(content: string): Promise<CustomInstructionSafetyDecision> {
    const decision = await this.audit.sanitize(content);
    if (!decision.accepted) {
      return decision;
    }

    return {
      accepted: true,
      reason: decision.reason,
      sourceRevision: decision.sourceRevision,
      context: createCustomInstructionContext(decision.maskedContent),
      result: decision.result
    };
  }
}
