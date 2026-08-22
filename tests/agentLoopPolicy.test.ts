import { describe, expect, it } from "vitest";
import type { MentorResponse } from "../src/domain/types";
import {
  firstBlockingTimelineAction,
  isTimelineActionInOrder,
  shouldContinueAfterEditApplied,
  shouldRetryAfterPatchApplyFailed
} from "../src/webview/agentLoopPolicy";

function response(override: Partial<MentorResponse> = {}): MentorResponse {
  return {
    title: "応答",
    sections: [],
    policyWarnings: [],
    toolCalls: [
      {
        type: "apply_patch",
        intent: "ファイルを作成します。",
        patch: [
          "*** Begin Patch",
          "*** Add File: src/App.tsx",
          "+export default function App() { return null; }",
          "*** End Patch"
        ].join("\n")
      }
    ],
    ...override
  };
}

describe("shouldContinueAfterEditApplied", () => {
  it("continues after an edit-only implementation response", () => {
    expect(shouldContinueAfterEditApplied({
      hintLevel: "very_high",
      response: response(),
      alreadyContinued: false,
      serverMentorPending: false
    })).toBe(true);
  });

  it("does not continue when the same response already has a command proposal", () => {
    expect(shouldContinueAfterEditApplied({
      hintLevel: "very_high",
      response: response({
        toolCalls: [
          ...(response().toolCalls ?? []),
          {
            type: "run_command",
            shell: "bash",
            command: "mvn clean compile",
            workingDirectory: ".",
            meaning: "ビルドを検証します。",
            expectedResult: "BUILD SUCCESS"
          }
        ]
      }),
      alreadyContinued: false,
      serverMentorPending: false
    })).toBe(false);
  });

  it("does not continue when the same response requires MCP tool approval", () => {
    expect(shouldContinueAfterEditApplied({
      hintLevel: "very_high",
      response: response({
        toolCalls: [
          ...(response().toolCalls ?? []),
          {
            type: "mcp_tool",
            serverId: "project-tools",
            toolName: "lookup",
            arguments: { id: "one" },
            intent: "対象を確認します。",
            expectedResult: "対象の情報を取得します。"
          }
        ]
      }),
      alreadyContinued: false,
      serverMentorPending: false
    })).toBe(false);
  });

  it("continues after a manual implementation response without an apply_patch tool call", () => {
    expect(shouldContinueAfterEditApplied({
      hintLevel: "very_high",
      response: response({
        toolCalls: [],
        manualImplementation: {
          required: true,
          reason: "安全検証で自動編集できないため手動実装します。",
          targetFiles: ["src/App.tsx"]
        }
      }),
      alreadyContinued: false,
      serverMentorPending: false
    })).toBe(true);
  });

  it("does not continue for lower hint levels or duplicate/pending loops", () => {
    expect(shouldContinueAfterEditApplied({
      hintLevel: "medium",
      response: response(),
      alreadyContinued: false,
      serverMentorPending: false
    })).toBe(false);
    expect(shouldContinueAfterEditApplied({
      hintLevel: "high",
      response: response(),
      alreadyContinued: true,
      serverMentorPending: false
    })).toBe(false);
    expect(shouldContinueAfterEditApplied({
      hintLevel: "high",
      response: response(),
      alreadyContinued: false,
      serverMentorPending: true
    })).toBe(false);
  });
});

describe("timeline action ordering", () => {
  it("allows only the oldest blocking timeline action", () => {
    const actions = [
      { key: "message-1:applyPatch", label: "編集案を適用 / 実装完了" },
      { key: "message-1:runCommand", label: "コマンド実行を承認 / コマンド実行完了" }
    ];

    expect(firstBlockingTimelineAction(actions)).toMatchObject({
      key: "message-1:applyPatch"
    });
    expect(isTimelineActionInOrder(actions, "message-1:applyPatch")).toBe(true);
    expect(isTimelineActionInOrder(actions, "message-1:runCommand")).toBe(false);
  });

  it("ignores optional review actions when selecting the next required action", () => {
    const actions = [
      { key: "message-1:manualReview", label: "実装内容をレビュー", orderExempt: true },
      { key: "message-2:runCommand", label: "コマンド実行を承認 / コマンド実行完了" }
    ];

    expect(firstBlockingTimelineAction(actions)).toMatchObject({
      key: "message-2:runCommand"
    });
    expect(isTimelineActionInOrder(actions, "message-2:runCommand")).toBe(true);
  });
});

describe("shouldRetryAfterPatchApplyFailed", () => {
  it("retries a stale patch once when target files are known", () => {
    expect(shouldRetryAfterPatchApplyFailed({
      hasPatchToolCall: true,
      targetFileCount: 1,
      alreadyRetried: false,
      serverMentorPending: false,
      workspaceTrusted: true
    })).toBe(true);
  });

  it("does not retry without a patch, without targets, during pending requests, or after one retry", () => {
    const base = {
      hasPatchToolCall: true,
      targetFileCount: 1,
      alreadyRetried: false,
      serverMentorPending: false,
      workspaceTrusted: true
    };

    expect(shouldRetryAfterPatchApplyFailed({ ...base, hasPatchToolCall: false })).toBe(false);
    expect(shouldRetryAfterPatchApplyFailed({ ...base, targetFileCount: 0 })).toBe(false);
    expect(shouldRetryAfterPatchApplyFailed({ ...base, alreadyRetried: true })).toBe(false);
    expect(shouldRetryAfterPatchApplyFailed({ ...base, serverMentorPending: true })).toBe(false);
    expect(shouldRetryAfterPatchApplyFailed({ ...base, workspaceTrusted: false })).toBe(false);
  });
});
