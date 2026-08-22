import { describe, expect, it } from "vitest";
import {
  CUSTOM_INSTRUCTION_MAX_BYTES,
  CustomInstructionGuard,
  CustomInstructionSafetyAudit,
  createCustomInstructionContext,
  customInstructionRevision,
  isCustomInstructionContext
} from "../src/domain/customInstructions";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import type {
  AsyncSemanticDetector,
  SemanticDetectionResult,
  SemanticFileInput
} from "../src/domain/privacy/semanticTypes";

class RecordingSemanticDetector implements AsyncSemanticDetector {
  public readonly name = "recording-semantic";
  public calls = 0;
  public lastContent = "";

  public constructor(private readonly failure?: Error) {}

  public async detectFile(file: SemanticFileInput): Promise<SemanticDetectionResult> {
    this.calls += 1;
    this.lastContent = file.maskedContent;
    if (this.failure) {
      throw this.failure;
    }
    return {
      findings: [],
      review: {
        status: "completed",
        model: "test-local-model",
        location: "vscode_extension_host",
        detectedTypes: file.findings.map((finding) => finding.type),
        educationSummary: "安全確認を完了しました。",
        riskPoints: [],
        recommendedAction: "マスク済み内容だけを送信します。"
      }
    };
  }
}

describe("custom instructions", () => {
  it("creates a self-verifying transport context", () => {
    const context = createCustomInstructionContext("日本語で簡潔に回答する。");

    expect(isCustomInstructionContext(context)).toBe(true);
    expect(isCustomInstructionContext({ ...context, content: "改ざん" })).toBe(false);
  });

  it("rejects secret-shaped content instead of silently masking it", () => {
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const decision = new CustomInstructionGuard().inspect(`API_KEY=${fakeKey}`);

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain("秘密情報候補");
  });

  it("rejects oversized content", () => {
    const decision = new CustomInstructionGuard().inspect("a".repeat(CUSTOM_INSTRUCTION_MAX_BYTES + 1));

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain("バイトを超えています");
  });

  it("skips the local LLM when mechanical secret detection finds nothing", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new CustomInstructionSafetyAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));
    const content = "日本語で簡潔に回答する。";

    const decision = await audit.sanitize(content);

    expect(decision.accepted).toBe(true);
    expect(detector.calls).toBe(0);
    if (decision.accepted) {
      expect(decision.context.content).toBe(content);
      expect(decision.sourceRevision).toBe(customInstructionRevision(content));
    }
  });

  it("masks detected credentials before the local LLM and external transport", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new CustomInstructionSafetyAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const decision = await audit.sanitize(`API_KEY=${fakeKey}`);

    expect(decision.accepted).toBe(true);
    expect(detector.calls).toBe(1);
    expect(detector.lastContent).toContain("__OPENAI_API_KEY_1__");
    expect(detector.lastContent).not.toContain(fakeKey);
    if (decision.accepted) {
      expect(decision.context.content).toContain("__OPENAI_API_KEY_1__");
      expect(decision.context.content).not.toContain(fakeKey);
      expect(new CustomInstructionGuard().inspect(decision.context.content).accepted).toBe(true);
    }
  });

  it("stops external transport when required local LLM review fails", async () => {
    const detector = new RecordingSemanticDetector(new Error("runtime unavailable"));
    const audit = new CustomInstructionSafetyAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const decision = await audit.sanitize(`API_KEY=${fakeKey}`);

    expect(decision.accepted).toBe(false);
    expect(decision.reason).toContain("外部送信を停止");
    expect(decision.result.localLlmReview?.status).toBe("failed");
    expect("context" in decision).toBe(false);
  });
});
