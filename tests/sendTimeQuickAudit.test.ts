import { describe, expect, it } from "vitest";
import type { DetectionFinding, LocalLlmReview } from "../src/domain/types";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { SendTimeQuickAudit } from "../src/domain/privacy/sendTimeQuickAudit";
import type { AsyncSemanticDetector, SemanticDetectionResult, SemanticFileInput } from "../src/domain/privacy/semanticTypes";

class RecordingSemanticDetector implements AsyncSemanticDetector {
  public readonly name = "recording-semantic";
  public readonly paths: string[] = [];
  public readonly contents: string[] = [];

  public constructor(
    private readonly failPath?: string,
    private readonly findings: readonly DetectionFinding[] = []
  ) {}

  public async detectFile(file: SemanticFileInput): Promise<SemanticDetectionResult> {
    this.paths.push(file.path);
    this.contents.push(file.maskedContent);
    if (this.failPath === file.path) {
      throw new Error("Bonsai test failure");
    }

    return {
      findings: this.findings,
      review: this.review()
    };
  }

  private review(): LocalLlmReview {
    return {
      status: "completed",
      model: "1-Bit Bonsai 1.7B",
      location: "vscode_extension_host",
      detectedTypes: [],
      educationSummary: "AIによるセキュリティ確認を完了しました。",
      riskPoints: [
        "未マスク機密情報は検出されていません。"
      ],
      recommendedAction: "承認済みマスク済み内容だけを送信してください。",
      guidanceSource: "bonsai_generated"
    };
  }
}

const contextPackage = {
  files: [
    {
      path: "src/target.ts",
      maskedContent: "export const endpoint = '__INTERNAL_URL_1__';"
    },
    {
      path: "src/other.ts",
      maskedContent: "export const value = 1;"
    }
  ],
  blockedFiles: [],
  summary: {
    scannedFiles: 2,
    includedFiles: 2,
    blockedFiles: 0,
    maskedFindings: 1,
    warningFindings: 0,
    criticalFindings: 0
  }
};

describe("SendTimeQuickAudit", () => {
  it("audits user prompt and requested target code without rescanning the workspace", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: "src/target.ts の実装方針を相談したい"
    }, contextPackage);

    expect(result.accepted).toBe(true);
    expect(result.targetPaths).toEqual(["src/target.ts"]);
    expect(detector.paths).not.toContain("mentor-request/task.txt");
    expect(detector.paths).toContain("src/target.ts");
    expect(detector.paths).not.toContain("src/other.ts");
    expect(detector.contents.find((content) => content.includes("endpoint"))).toContain("[removed]");
    expect(detector.contents.find((content) => content.includes("endpoint"))).not.toContain("__INTERNAL_URL_1__");
    expect(result.reason).toContain("送信前の安全確認");
  });

  it("skips repeated Bonsai target audits when their audit keys are already reviewed", async () => {
    const firstDetector = new RecordingSemanticDetector();
    const firstAudit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: firstDetector,
      requireSemanticScan: true
    }));

    const first = await firstAudit.audit({
      task: "src/target.ts の実装方針を相談したい"
    }, contextPackage);
    expect(first.targetAuditKeys).toHaveLength(1);
    expect(firstDetector.paths).toContain("src/target.ts");

    const secondDetector = new RecordingSemanticDetector();
    const secondAudit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: secondDetector,
      requireSemanticScan: true
    }));
    const second = await secondAudit.audit({
      task: "src/target.ts の実装方針を相談したい"
    }, contextPackage, {
      skipTargetAuditKeys: new Set(first.targetAuditKeys)
    });

    expect(second.accepted).toBe(true);
    expect(second.targetPaths).toEqual(["src/target.ts"]);
    expect(second.targetResults).toEqual([]);
    expect(second.targetAuditKeys).toEqual([]);
    expect(second.skippedTargetAuditKeys).toEqual(first.targetAuditKeys);
    expect(secondDetector.paths).toEqual([]);
    expect(second.reason).toContain("AIによるセキュリティ確認を省略");
  });

  it("skips Bonsai target audit when selected target code has no masked placeholders", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: "src/other.ts の実装方針を相談したい"
    }, contextPackage);

    expect(result.accepted).toBe(true);
    expect(result.targetPaths).toEqual([]);
    expect(detector.paths).toEqual([]);
  });

  it("rejects unmasked secrets left inside the approved context package", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const result = await audit.audit({
      task: "src/target.ts を確認したい"
    }, {
      ...contextPackage,
      files: [
        {
          path: "src/target.ts",
          maskedContent: `const key = "${fakeKey}";`
        }
      ]
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("ContextPackage");
    expect(result.reason).toContain("src/target.ts");
  });

  it("keeps masked context usable when Bonsai cannot complete the target-code quick audit", async () => {
    const detector = new RecordingSemanticDetector("src/target.ts");
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: "src/target.ts の例外処理を確認したい"
    }, contextPackage);

    expect(result.accepted).toBe(true);
    expect(result.targetResults[0]?.blocked).toBe(false);
    expect(result.targetResults[0]?.localLlmReview?.status).toBe("failed");
    expect(result.targetResults[0]?.findings.find((finding) => finding.type === "LOCAL_LLM_UNAVAILABLE")?.action).toBe("warn");
  });

  it("keeps masked context usable when Bonsai reports additional target-code mask findings", async () => {
    const semanticFinding: DetectionFinding = {
      id: "semantic-mask-1",
      detector: "recording-semantic",
      type: "SEMANTIC_CONFIDENTIAL_HINT",
      severity: "medium",
      action: "mask",
      start: 0,
      end: 8,
      reason: "マスク済みコンテキストに追加の注意点を検出しました。"
    };
    const detector = new RecordingSemanticDetector(undefined, [semanticFinding]);
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: "src/target.ts の環境構築結果を確認したい"
    }, contextPackage);

    expect(result.accepted).toBe(true);
    expect(result.targetPaths).toEqual(["src/target.ts"]);
    expect(result.targetResults[0]?.findings.find((finding) => finding.id === semanticFinding.id)?.action).toBe("mask");
  });

  it("extracts target paths from diff metadata", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: [
        "この差分を確認したい",
        "diff --git a/src/target.ts b/src/target.ts",
        "+++ b/src/target.ts",
        "+export const endpoint = '__INTERNAL_URL_1__';"
      ].join("\n")
    }, contextPackage);

    expect(result.accepted).toBe(true);
    expect(result.targetPaths).toEqual(["src/target.ts"]);
    expect(detector.paths).toContain("src/target.ts");
    expect(detector.paths).not.toContain("src/other.ts");
  });

  it("rejects private key material in user prompts before App Server requests", async () => {
    const detector = new RecordingSemanticDetector();
    const audit = new SendTimeQuickAudit(new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    }));

    const result = await audit.audit({
      task: [
        "この鍵を見てください",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "abc",
        "-----END OPENSSH PRIVATE KEY-----"
      ].join("\n")
    }, contextPackage);

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("ユーザープロンプト");
  });
});
