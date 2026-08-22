import { describe, expect, it } from "vitest";
import { ReferenceContextGuard } from "../src/domain/mentor/referenceContextGuard";

const summary = {
  scannedFiles: 1,
  includedFiles: 1,
  blockedFiles: 0,
  maskedFindings: 0,
  warningFindings: 0,
  criticalFindings: 0
} as const;

describe("ReferenceContextGuard", () => {
  it("accepts a complete explicitly referenced document", () => {
    const guard = new ReferenceContextGuard();

    expect(guard.inspect(
      {
        task: "@POLICY.html の内容を確認してください",
        hintLevel: "low"
      },
      {
        files: [
          {
            path: "POLICY.html",
            maskedContent: "<h1>方針</h1>",
            contextSource: "explicit_reference",
            sourceSizeBytes: 15,
            includedSizeBytes: 15,
            contentComplete: true
          }
        ],
        blockedFiles: [],
        summary
      }
    )).toEqual([]);
  });

  it("rejects an incomplete explicitly referenced document", () => {
    const guard = new ReferenceContextGuard();
    const issues = guard.inspect(
      {
        task: "@POLICY.html の内容を確認してください",
        hintLevel: "low"
      },
      {
        files: [
          {
            path: "POLICY.html",
            maskedContent: "",
            contextSource: "explicit_reference",
            sourceSizeBytes: 80_000,
            includedSizeBytes: 0,
            contentComplete: false
          }
        ],
        blockedFiles: [],
        summary
      }
    );

    expect(issues).toEqual([
      {
        path: "POLICY.html",
        reason: "資料全体を取得できませんでした（元サイズ 80000 bytes / 取得 0 bytes）"
      }
    ]);
    expect(guard.rejectionResponse(issues).title).toBe("指定資料を完全に確認できません");
  });

  it("rejects a requested document omitted by Privacy Guard", () => {
    const guard = new ReferenceContextGuard();

    expect(guard.inspect(
      {
        task: "@POLICY.html の内容を確認してください",
        hintLevel: "low"
      },
      {
        files: [],
        blockedFiles: [
          {
            path: "POLICY.html",
            reason: "高リスク秘密情報を検出しました",
            contextSource: "explicit_reference",
            contentComplete: false
          }
        ],
        summary: {
          ...summary,
          includedFiles: 0,
          blockedFiles: 1
        }
      }
    )).toEqual([
      {
        path: "POLICY.html",
        reason: "高リスク秘密情報を検出しました"
      }
    ]);
  });

  it("rejects a mentioned document that is absent from legacy context metadata", () => {
    const guard = new ReferenceContextGuard();

    expect(guard.inspect(
      {
        task: "@POLICY.html を確認してください",
        hintLevel: "low"
      },
      {
        files: [],
        blockedFiles: [],
        summary: {
          ...summary,
          includedFiles: 0
        }
      }
    )).toEqual([
      {
        path: "POLICY.html",
        reason: "指定された資料が送信コンテキストに含まれていません"
      }
    ]);
  });
});
