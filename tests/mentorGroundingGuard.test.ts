import { describe, expect, it } from "vitest";
import { MentorGroundingGuard } from "../src/server/llm/mentorGroundingGuard";
import { MentorResponseGenerator } from "../src/server/llm/mentorResponseGenerator";
import type { ContextPackage, MentorResponse } from "../src/domain/types";

const contextPackage: ContextPackage = {
  files: [
    {
      path: "POLICY.html",
      maskedContent: [
        "<html>",
        "<head>",
        "<meta content=\"React、Java 17、Spring Boot、PostgreSQLで構築する適応型問題演習プラットフォーム\" name=\"description\">",
        "<title>Java SE 17 Programmer I 適応型問題演習プラットフォーム</title>",
        "</head>",
        "<body><h1>Java Programmer I 適応型問題演習基盤</h1><h2>技術判断</h2></body>",
        "</html>"
      ].join(""),
      contextSource: "explicit_reference",
      sourceSizeBytes: 300,
      includedSizeBytes: 300,
      contentComplete: true
    }
  ],
  blockedFiles: [],
  summary: {
    scannedFiles: 1,
    includedFiles: 1,
    blockedFiles: 0,
    maskedFindings: 0,
    warningFindings: 0,
    criticalFindings: 0
  }
};

const response = (...items: readonly string[]): MentorResponse => ({
  title: "資料確認結果",
  sections: [
    {
      heading: "確認できた事実",
      items
    }
  ],
  policyWarnings: []
});

describe("MentorGroundingGuard", () => {
  it("accepts document-specific facts at a low hint level", () => {
    const guard = new MentorGroundingGuard();

    expect(guard.validate(
      response(
        "対象はJava SE 17 Programmer I向けの適応型問題演習基盤です。",
        "React、Spring Boot、PostgreSQLを採用します。"
      ),
      {
        task: "@POLICY.html の内容を確認してプロジェクトを把握してください",
        hintLevel: "low"
      },
      contextPackage
    )).toEqual([]);
  });

  it("rejects a generic roadmap that delegates reading to the user", () => {
    const guard = new MentorGroundingGuard();
    const issues = guard.validate(
      response(
        "ご自身でポリシーファイルの記述内容を確認してください。",
        "まずPOLICY.htmlを直接開き、要点を整理します。"
      ),
      {
        task: "@POLICY.html の内容を確認してプロジェクトを把握してください",
        hintLevel: "low"
      },
      contextPackage
    );

    expect(issues).toEqual([
      expect.stringContaining("読解をユーザーへ丸投げ"),
      expect.stringContaining("資料固有の事実を2点以上")
    ]);
  });

  it("does not require document anchors for unrelated implementation requests", () => {
    const guard = new MentorGroundingGuard();

    expect(guard.validate(
      response("実装方針を整理します。"),
      {
        task: "ログ出力を追加してください",
        hintLevel: "high"
      },
      contextPackage
    )).toEqual([]);
  });

  it("regenerates a generic low-level response before accepting grounded facts", async () => {
    const generator = new MentorResponseGenerator();
    const repairFeedbacks: readonly string[][] = [];

    const result = await generator.generate({
      source: "Test",
      request: {
        task: "@POLICY.html の内容を確認してプロジェクトを把握してください",
        hintLevel: "low"
      },
      contextPackage,
      fetchText: async (repairFeedback, attempt) => {
        (repairFeedbacks as string[][]).push([...repairFeedback]);
        return JSON.stringify(attempt === 1
          ? response("ご自身でPOLICY.htmlを開き、要点を確認してください。")
          : response(
            "Java SE 17 Programmer I向けの適応型問題演習基盤です。",
            "React、Spring Boot、PostgreSQLを採用します。"
          ));
      }
    });

    expect(result.sections[0]?.items).toContain("Java SE 17 Programmer I向けの適応型問題演習基盤です。");
    expect(repairFeedbacks).toHaveLength(2);
    expect(repairFeedbacks[1]?.join("\n")).toContain("読解をユーザーへ丸投げ");
  });
});
