import { describe, expect, it } from "vitest";
import { MentorEngine } from "../src/domain/mentor/mentorEngine";

describe("MentorEngine", () => {
  it("responds to the chat request without code blocks", () => {
    const engine = new MentorEngine();
    const response = engine.respond({
      task: "送信前プレビューを作る"
    });

    const serialized = JSON.stringify(response);
    expect(response.title).toBe("メンター応答");
    expect(serialized).toContain("送信前プレビューを作る");
    expect(serialized).not.toContain("```");
    expect(serialized).not.toContain("function ");
  });

  it("uses the hint level as depth control without changing request mode", () => {
    const engine = new MentorEngine();
    const response = engine.respond({
      task: "検出結果を説明したい",
      hintLevel: "medium"
    });

    const section = response.sections.find((item) => item.heading === "次の確認");
    expect(section?.items).toHaveLength(3);
  });

  it("keeps repository content warnings in the generic mentor response", () => {
    const engine = new MentorEngine();
    const response = engine.respond({
      task: "外部API送信処理の確認",
      guardSummary: {
        scannedFiles: 3,
        includedFiles: 2,
        blockedFiles: 1,
        maskedFindings: 1,
        warningFindings: 0,
        criticalFindings: 0
      }
    });

    const serialized = JSON.stringify(response);
    expect(serialized).toContain("未信頼データ");
    expect(serialized).toContain("1 件のファイル");
    expect(serialized).not.toContain("```");
  });
});
