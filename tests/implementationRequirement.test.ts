import { describe, expect, it } from "vitest";
import { ImplementationRequirementResolver } from "../src/domain/mentor/implementationRequirement";

describe("ImplementationRequirementResolver", () => {
  it("requires apply_patch for high-level implementation tasks", () => {
    const resolver = new ImplementationRequirementResolver();

    const result = resolver.resolve({
      task: "Java Spring Frameworkでタスク管理アプリを開発したいです。MySQLを使う環境構築を行ってください。",
      hintLevel: "very_high"
    });

    expect(result.requiresPatch).toBe(true);
    expect(result.reason).toContain("apply_patch");
  });

  it("does not require apply_patch for review-only or lower hint requests", () => {
    const resolver = new ImplementationRequirementResolver();

    expect(resolver.resolve({
      task: "環境構築ができているか確認してください。",
      hintLevel: "very_high"
    }).requiresPatch).toBe(false);

    expect(resolver.resolve({
      task: "タスク管理アプリを実装してください。",
      hintLevel: "medium"
    }).requiresPatch).toBe(false);
  });

  it("does not treat tool results as fresh implementation requests", () => {
    const resolver = new ImplementationRequirementResolver();

    const result = resolver.resolve({
      task: [
        "承認済みコマンドの実行結果を受け取りました。",
        "conversationContext.lastCommandResult を前回 run_command の実行結果として扱ってください。",
        "exitCode が 0 の場合は新しい編集案を出さないでください。"
      ].join("\n"),
      hintLevel: "very_high"
    });

    expect(result.requiresPatch).toBe(false);
  });

  it("does not treat MCP tool results as fresh implementation requests", () => {
    const resolver = new ImplementationRequirementResolver();

    const result = resolver.resolve({
      task: [
        "承認済みMCP Toolの実行結果を受け取りました。",
        "これは直前のmcp_toolに対するtool resultです。",
        "結果を解釈し、次の安全な手順を説明してください。"
      ].join("\n"),
      hintLevel: "very_high"
    });

    expect(result.requiresPatch).toBe(false);
  });
});
