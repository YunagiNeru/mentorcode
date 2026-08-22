import { describe, expect, it } from "vitest";
import type { MentorResponse } from "../src/domain/types";
import { MentorOutputGuard } from "../src/server/llm/mentorOutputGuard";

function baseResponse(override: Partial<MentorResponse> = {}): MentorResponse {
  return {
    title: "メンター応答",
    sections: [
      {
        heading: "方針",
        items: ["環境変数を使って設定します。"]
      }
    ],
    policyWarnings: [],
    ...override
  };
}

describe("MentorOutputGuard", () => {
  it("allows apply_patch tool calls with local config values", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: [
        {
          type: "apply_patch",
          intent: "MySQL設定を追加します。",
          patch: [
            "*** Begin Patch",
            "*** Add File: docker-compose.yml",
            "+services:",
            "+  db:",
            "+    image: mysql:8.0",
            "+    environment:",
            "+      MYSQL_ROOT_PASSWORD: rootpassword",
            "+      MYSQL_PASSWORD: task_password",
            "+      DATABASE_URL: mysql://task_user:task_password@db:3306/task_db",
            "*** End Patch"
          ].join("\n")
        }
      ]
    });

    expect(() => guard.assertSafe(response, {
      task: "MySQL環境を作る",
      hintLevel: "very_high"
    })).not.toThrow();
  });

  it("rejects apply_patch tool calls that write masked placeholders", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: [
        {
          type: "apply_patch",
          intent: "マスク済み値を書き戻します。",
          patch: [
            "*** Begin Patch",
            "*** Add File: src/config.ts",
            "+export const apiKey = \"__OPENAI_API_KEY_1__\";",
            "*** End Patch"
          ].join("\n")
        }
      ]
    });

    expect(() => guard.assertSafe(response, {
      task: "設定を書く",
      hintLevel: "very_high"
    })).toThrow("output safety");
  });

  it("rejects run_command tool calls that directly mutate files", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: [
        {
          type: "run_command",
          shell: "powershell",
          command: "\"spring.datasource.url=x\" | Set-Content src/main/resources/application.properties",
          workingDirectory: ".",
          meaning: "設定ファイルを書き換えます。",
          expectedResult: "設定が反映されます。"
        }
      ]
    });

    expect(() => guard.assertSafe(response, {
      task: "設定を書く",
      hintLevel: "very_high"
    })).toThrow("output safety");
  });

  it("drops dependent commands when an apply_patch tool call fails safety validation", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: [
        {
          type: "apply_patch",
          intent: "マスク済み値を書き戻します。",
          patch: [
            "*** Begin Patch",
            "*** Add File: src/config.ts",
            "+export const apiKey = \"__OPENAI_API_KEY_1__\";",
            "*** End Patch"
          ].join("\n")
        },
        {
          type: "run_command",
          shell: "bash",
          command: "npm test",
          workingDirectory: ".",
          meaning: "編集後のテストを実行します。",
          expectedResult: "テストが成功します。"
        }
      ]
    });

    const sanitized = guard.sanitizeToolCalls(response, {
      task: "設定を書く",
      hintLevel: "very_high"
    });

    expect(sanitized.discardedPatchToolCall).toBe(true);
    expect(sanitized.response.toolCalls).toBeUndefined();
    expect(sanitized.response.policyWarnings).toContain("一部のツール提案は安全検証を通過しなかったため破棄しました。");
  });

  it("allows only MCP calls present in the supplied catalog", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: [{
        type: "mcp_tool",
        serverId: "project-tools",
        toolName: "lookup",
        arguments: { id: "one" },
        intent: "確認する",
        expectedResult: "結果を得る"
      }]
    });
    const context = {
      files: [],
      blockedFiles: [],
      summary: {
        scannedFiles: 0,
        includedFiles: 0,
        blockedFiles: 0,
        maskedFindings: 0,
        warningFindings: 0,
        criticalFindings: 0
      }
    };

    expect(guard.validateToolPlan(response, context, {
      tools: [{
        serverId: "project-tools",
        serverName: "Project Tools",
        name: "lookup",
        inputSchema: { type: "object" }
      }]
    })).toEqual([]);
    expect(guard.validateToolPlan(response, context)).toContain(
      "toolCalls[0] は送信済みMCP Tool候補に一致しません。"
    );
  });

  it("rejects more than one MCP tool proposal in a response", () => {
    const guard = new MentorOutputGuard();
    const response = baseResponse({
      toolCalls: ["one", "two"].map((id) => ({
        type: "mcp_tool" as const,
        serverId: "project-tools",
        toolName: "lookup",
        arguments: { id },
        intent: `${id}を確認する`,
        expectedResult: `${id}の結果を得る`
      }))
    });
    const context = {
      files: [],
      blockedFiles: [],
      summary: {
        scannedFiles: 0,
        includedFiles: 0,
        blockedFiles: 0,
        maskedFindings: 0,
        warningFindings: 0,
        criticalFindings: 0
      }
    };
    const mcpContext = {
      tools: [{
        serverId: "project-tools",
        serverName: "Project Tools",
        name: "lookup",
        inputSchema: { type: "object" }
      }]
    };

    expect(guard.validateToolPlan(response, context, mcpContext)).toContain(
      "1回の応答で提案できるmcp_toolは1件までです。"
    );
  });
});
