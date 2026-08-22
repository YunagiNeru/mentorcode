import { describe, expect, it } from "vitest";
import { BonsaiProjectReviewer } from "../src/localLlm/bonsaiProjectReviewer";
import type { BonsaiResolvedPaths } from "../src/localLlm/bonsaiManifest";
import type { ContextPackage, WorkspaceMap } from "../src/domain/types";

class MockProjectRuntime {
  public lastPrompt = "";

  public constructor(private readonly output: string | Error) {}

  public async verify(): Promise<BonsaiResolvedPaths> {
    if (this.output instanceof Error) {
      throw this.output;
    }

    return {
      root: "mock",
      modelPath: "mock/model.gguf",
      binaryPath: "mock/llama-cli.exe",
      runtimeDirectory: "mock"
    };
  }

  public async complete(prompt: string): Promise<string> {
    this.lastPrompt = prompt;
    if (this.output instanceof Error) {
      throw this.output;
    }

    return this.output;
  }
}

const contextPackage: ContextPackage = {
  files: [
    {
      path: "src/index.html",
      maskedContent: "<code>__GOOGLE_API_KEY_1__</code>"
    },
    {
      path: "README.md",
      maskedContent: "README with internal setup guidance"
    }
  ],
  blockedFiles: [
    {
      path: ".env",
      reason: "環境変数ファイルは秘密情報を含む可能性が高いため送信禁止です"
    }
  ],
  summary: {
    scannedFiles: 3,
    includedFiles: 2,
    blockedFiles: 1,
    maskedFindings: 1,
    warningFindings: 0,
    criticalFindings: 0
  }
};

const workspaceMap: WorkspaceMap = {
  totalFiles: 3,
  includedFiles: 2,
  excludedFiles: 1,
  languageHints: [
    "Markdown (1)",
    "HTML (1)"
  ],
  topLevelEntries: [
    "src",
    "README.md"
  ]
};

describe("BonsaiProjectReviewer", () => {
  it("creates a local project review from masked context", async () => {
    const runtime = new MockProjectRuntime([
      "banner",
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      "## 総評",
      "APIキー候補がマスク済みで、環境変数ファイルは除外されています。",
      "## 安全な修正方針",
      "実値は復元せず、Secret Managerへ移してください。"
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("completed");
    expect(result.guidanceSource).toBe("bonsai_generated");
    expect(result.reviewMarkdown).toContain("## 総評");
    expect(runtime.lastPrompt).toContain("__GOOGLE_API_KEY_1__");
    expect(runtime.lastPrompt).toContain("PROJECT_CONTEXT_START");
    expect(runtime.lastPrompt).not.toContain("AIza");
    expect(runtime.lastPrompt).not.toContain("再発行しない");
    expect(runtime.lastPrompt).not.toContain("本物の値");
    expect(runtime.lastPrompt).not.toContain("禁止:");
  });

  it("extracts project review text when llama output omits the response marker", async () => {
    const runtime = new MockProjectRuntime([
      "Loading model...",
      "> prompt was truncated",
      "# リスクの説明",
      "マスク済みContextから、認証情報候補と除外ファイルの関係を確認しました。",
      "安全な修正方針",
      "復元せず、環境変数やSecret Managerで管理してください。",
      "Exiting..."
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("completed");
    expect(result.reviewMarkdown).toContain("リスクの説明");
    expect(result.reviewMarkdown).not.toContain("Loading model");
    expect(result.reviewMarkdown).not.toContain("Exiting");
  });

  it("removes code blocks and placeholder instances from generated project reviews", async () => {
    const runtime = new MockProjectRuntime([
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      "総評",
      "GOOGLE_API_KEY_1 はマスク済みの認証情報候補です。",
      "```bash",
      "export GOOGLE_API_KEY_1=your_api_key_1",
      "```",
      "安全な修正方針",
      "環境変数やSecret Managerで管理し、必要に応じて無効化と再発行を行ってください。"
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("completed");
    expect(result.reviewMarkdown).toContain("GOOGLE_API_KEY はマスク済み");
    expect(result.reviewMarkdown).not.toContain("```");
    expect(result.reviewMarkdown).not.toContain("your_api_key");
  });

  it("removes repeated sections from generated project reviews", async () => {
    const runtime = new MockProjectRuntime([
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      "# リスク評価",
      "最初の評価です。",
      "# リスク評価",
      "重複した評価です。",
      "# 安全な修正方針",
      "秘密情報は安全な保管場所へ移してください。"
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("completed");
    expect(result.reviewMarkdown).toContain("最初の評価");
    expect(result.reviewMarkdown).not.toContain("重複した評価");
  });

  it("fails the project review when Bonsai output contains unmasked secrets", async () => {
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";
    const runtime = new MockProjectRuntime([
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      `## 総評\n出力に ${fakeKey} が含まれています。`
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("failed");
    expect(result.guidanceSource).toBe("safety_template");
    expect(result.reviewMarkdown).not.toContain(fakeKey);
    expect(result.failureReason).toContain("safety recheck");
  });

  it("fails the project review when Bonsai recommends unsafe secret handling", async () => {
    const runtime = new MockProjectRuntime([
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      "総評",
      "本物のキーに置き換える方針を確認してください。"
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("unsafe recommendation");
  });

  it("fails the project review when Bonsai contradicts credential rotation guidance", async () => {
    const runtime = new MockProjectRuntime([
      "BEGIN_LOCAL_BONSAI_PROJECT_REVIEW",
      "総評",
      "秘密情報の再発行は禁止されています。"
    ].join("\n"));
    const reviewer = new BonsaiProjectReviewer({ runtime });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("unsafe recommendation");
  });

  it("keeps project review failure separate from context package gating", async () => {
    const reviewer = new BonsaiProjectReviewer({
      runtime: new MockProjectRuntime(new Error("runtime unavailable"))
    });

    const result = await reviewer.review({
      rootName: "test_project",
      contextPackage,
      workspaceMap
    });

    expect(result.status).toBe("failed");
    expect(result.targetFiles).toBe(3);
    expect(result.reviewMarkdown).toContain("補助レビュー");
  });
});
