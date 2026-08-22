import { describe, expect, it } from "vitest";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { BonsaiSemanticDetector } from "../src/localLlm/bonsaiSemanticDetector";
import type { BonsaiClassification } from "../src/localLlm/bonsaiRuntime";
import type { BonsaiResolvedPaths } from "../src/localLlm/bonsaiManifest";

class MockBonsaiRuntime {
  public lastSnippet = "";
  public classifyCalls = 0;

  public constructor(
    private readonly classification: BonsaiClassification | Error
  ) {}

  public async verify(): Promise<BonsaiResolvedPaths> {
    if (this.classification instanceof Error) {
      throw this.classification;
    }

    return {
      root: "mock",
      modelPath: "mock/model.gguf",
      binaryPath: "mock/llama-cli.exe",
      runtimeDirectory: "mock"
    };
  }

  public async classify(_path: string, snippet: string): Promise<BonsaiClassification> {
    this.classifyCalls += 1;
    this.lastSnippet = snippet;
    if (this.classification instanceof Error) {
      throw this.classification;
    }

    return this.classification;
  }
}

describe("BonsaiSemanticDetector", () => {
  it("keeps masked content usable when Bonsai detects likely credentials", async () => {
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";
    const detector = new BonsaiSemanticDetector({
      runtime: new MockBonsaiRuntime({
        verdict: "credential_likely",
        confidence: 0.91
      })
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });

    const result = await guard.analyzeFileAsync({
      path: "src/comment.ts",
      content: `const apiKey = "${fakeKey}";`
    });

    const semanticFinding = result.findings.find((finding) => finding.detector === "bonsai-1bit-semantic");
    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toContain("__OPENAI_API_KEY_1__");
    expect(result.maskedContent).not.toContain(fakeKey);
    expect(semanticFinding?.type).toBe("BONSAI_CREDENTIAL_LIKELY");
    expect(semanticFinding?.action).toBe("warn");
    expect(result.localLlmReview?.verdict).toBe("credential_likely");
  });

  it("does not weaken mechanical secret detection when Bonsai says safe", async () => {
    const runtime = new MockBonsaiRuntime({
      verdict: "safe",
      confidence: 0.99
    });
    const detector = new BonsaiSemanticDetector({
      runtime
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const result = await guard.analyzeFileAsync({
      path: "src/config.ts",
      content: `const apiKey = "${fakeKey}";`
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toContain("__OPENAI_API_KEY_1__");
    expect(result.maskedContent).not.toContain(fakeKey);
    expect(result.localLlmReview?.status).toBe("completed");
    expect(result.localLlmReview?.detectedTypes).toContain("OPENAI_API_KEY");
    expect(result.localLlmReview?.educationSummary).toContain("AIによるセキュリティ確認");
    expect(result.localLlmReview?.verdict).toBe("safe");
    expect(result.localLlmReview?.confidence).toBe(0.99);
    expect(result.localLlmReview?.guidanceSource).toBe("safety_template");
    expect(runtime.lastSnippet).toContain("__OPENAI_API_KEY_1__");
    expect(runtime.lastSnippet).not.toContain(fakeKey);
    expect(runtime.lastSnippet).toContain("Every placeholder like __TYPE_1__ is a redacted original value");
    expect(runtime.lastSnippet).toContain("Never recommend unmasking");
  });

  it("carries Bonsai review details into context packages", async () => {
    const detector = new BonsaiSemanticDetector({
      runtime: new MockBonsaiRuntime({
        verdict: "safe",
        confidence: 0.88
      })
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });
    const fakeKey = "AIza" + "abcdefghijklmnopqrstuvwxyzabcdefghi";

    const contextPackage = await guard.createContextPackageAsync([
      {
        path: "index.html",
        content: `<code>${fakeKey}</code>`
      }
    ]);

    expect(contextPackage.files[0]?.maskedContent).toContain("__GOOGLE_API_KEY_1__");
    expect(contextPackage.files[0]?.localLlmReview?.status).toBe("completed");
    expect(contextPackage.files[0]?.localLlmReview?.model).toBe("1-Bit Bonsai 1.7B");
    expect(contextPackage.files[0]?.localLlmReview?.location).toBe("vscode_extension_host");
  });

  it("skips Bonsai for safe content without mechanical mask findings", async () => {
    const runtime = new MockBonsaiRuntime({
        verdict: "safe",
        confidence: 0.9
      });
    const detector = new BonsaiSemanticDetector({
      runtime
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });

    const result = await guard.analyzeFileAsync({
      path: "src/plain.ts",
      content: "export const value = 1;"
    });

    expect(result.blocked).toBe(false);
    expect(result.localLlmReview).toBeUndefined();
    expect(runtime.classifyCalls).toBe(0);
  });

  it("uses controlled Japanese guidance instead of Bonsai free text", async () => {
    const detector = new BonsaiSemanticDetector({
      runtime: new MockBonsaiRuntime({
        verdict: "private_internal",
        confidence: 0.61,
        educationSummary: "This looks fine and can be sent outside.",
        riskPoints: [
          "Replace the placeholder with the real key."
        ],
        recommendedAction: "Replace the placeholder with a real API key."
      })
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });
    const fakeKey = "AIza" + "abcdefghijklmnopqrstuvwxyzabcdefghi";

    const result = await guard.analyzeFileAsync({
      path: "index.html",
      content: `<code>${fakeKey}</code>`
    });

    expect(result.blocked).toBe(false);
    expect(result.localLlmReview?.status).toBe("completed");
    expect(result.localLlmReview?.educationSummary).toContain("AIによるセキュリティ確認");
    expect(result.localLlmReview?.recommendedAction).toContain("環境変数");
    expect(result.localLlmReview?.recommendedAction).not.toMatch(/real|replace/i);
    expect(result.localLlmReview?.riskPoints.join("\n")).not.toMatch(/real|replace/i);
    expect(result.localLlmReview?.guidanceSource).toBe("safety_template");
    expect(result.localLlmReview?.guidanceSourceReason).toContain("分類JSON");
  });

  it("does not fail closed for files without mechanical mask findings", async () => {
    const detector = new BonsaiSemanticDetector({
      runtime: new MockBonsaiRuntime(new Error("runtime unavailable"))
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });

    const result = await guard.analyzeFileAsync({
      path: "src/plain.ts",
      content: "export const value = 1;"
    });

    expect(result.blocked).toBe(false);
    expect(result.localLlmReview).toBeUndefined();
  });

  it("keeps masked content usable when Bonsai cannot complete semantic scanning", async () => {
    const detector = new BonsaiSemanticDetector({
      runtime: new MockBonsaiRuntime(new Error("runtime unavailable"))
    });
    const guard = new PrivacyGuard({
      semanticDetector: detector,
      requireSemanticScan: true
    });
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    const result = await guard.analyzeFileAsync({
      path: "src/config.ts",
      content: `const apiKey = "${fakeKey}";`
    });

    const failureFinding = result.findings.find((finding) => finding.type === "LOCAL_LLM_UNAVAILABLE");
    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toContain("__OPENAI_API_KEY_1__");
    expect(result.maskedContent).not.toContain(fakeKey);
    expect(failureFinding?.action).toBe("warn");
    expect(result.localLlmReview?.status).toBe("failed");
    expect(result.localLlmReview?.failureReason).toContain("semantic scan failed");
  });
});
