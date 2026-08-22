import { describe, expect, it } from "vitest";
import { implementationActionKinds, MentorActivityTracker } from "../src/domain/mentorActivity";
import type { MentorResponse } from "../src/domain/types";

function response(override: Partial<MentorResponse> = {}): MentorResponse {
  return {
    title: "PostgreSQL環境構築の提案",
    sections: [],
    policyWarnings: [],
    toolCalls: [
      {
        type: "apply_patch",
        intent: "Docker Compose設定ファイルを作成します。",
        patch: [
          "*** Begin Patch",
          "*** Add File: docker-compose.yml",
          "+services:",
          "+  db:",
          "+    image: postgres:15-alpine",
          "*** End Patch"
        ].join("\n")
      },
      {
        type: "run_command",
        shell: "bash",
        command: "docker-compose up -d",
        workingDirectory: ".",
        meaning: "PostgreSQLコンテナを起動します。",
        expectedResult: "5432ポートでPostgreSQLが待機します。"
      }
    ],
    ...override
  };
}

function commandOnlyResponse(): MentorResponse {
  const toolCalls = response().toolCalls?.filter((toolCall) => toolCall.type === "run_command") ?? [];
  return response({ toolCalls });
}

describe("implementationActionKinds", () => {
  it("counts edit and command actions only for high enough hint levels", () => {
    expect(implementationActionKinds(response(), "high")).toEqual(["applyPatch", "runCommand"]);
    expect(implementationActionKinds(response(), "very_high")).toEqual(["applyPatch", "runCommand"]);
    expect(implementationActionKinds(response(), "medium")).toEqual([]);
    expect(implementationActionKinds(response(), "low")).toEqual([]);
  });

  it("counts manual implementation responses as applyPatch actions for completion tracking", () => {
    expect(implementationActionKinds(response({
      toolCalls: [],
      manualImplementation: {
        required: true,
        reason: "安全検証で自動編集できないため手動実装します。",
        targetFiles: ["src/config.ts"]
      }
    }), "very_high")).toEqual(["applyPatch"]);
  });

  it("counts an MCP tool proposal as an explicit pending action", () => {
    expect(implementationActionKinds(response({
      toolCalls: [{
        type: "mcp_tool",
        serverId: "project-tools",
        toolName: "lookup",
        arguments: { id: "one" },
        intent: "対象を確認します。",
        expectedResult: "対象の情報を取得します。"
      }]
    }), "high")).toEqual(["mcpTool"]);
  });
});

describe("MentorActivityTracker", () => {
  it("counts one unread response plus two pending processes as badge value three", () => {
    const tracker = new MentorActivityTracker();

    const snapshot = tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });

    expect(snapshot).toMatchObject({
      unreadResponses: 1,
      pendingProcesses: 2,
      badgeValue: 3
    });
  });

  it("reading the response only removes the unread portion", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.markConversationRead("conversation-1")).toMatchObject({
      unreadResponses: 0,
      pendingProcesses: 2,
      badgeValue: 2
    });
  });

  it("marks only the requested conversation read when a request is sent", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });
    tracker.registerResponse({
      responseId: "response-2",
      conversationId: "conversation-2",
      messageId: "message-2",
      response: response(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.markConversationRead("conversation-1")).toMatchObject({
      unreadResponses: 1,
      pendingProcesses: 4,
      badgeValue: 5
    });
  });

  it("resolves a pressed action and marks only that message read", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: commandOnlyResponse(),
      hintLevel: "high",
      unread: true
    });
    tracker.registerResponse({
      responseId: "response-2",
      conversationId: "conversation-2",
      messageId: "message-2",
      response: commandOnlyResponse(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.resolveAction({
      messageId: "message-1",
      action: "runCommand",
      markRead: true
    })).toMatchObject({
      unreadResponses: 1,
      pendingProcesses: 1,
      badgeValue: 2
    });
  });

  it("clears the snapshot after the last unread pending action is pressed", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: commandOnlyResponse(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.resolveAction({
      messageId: "message-1",
      action: "runCommand",
      markRead: true
    })).toMatchObject({
      unreadResponses: 0,
      pendingProcesses: 0,
      badgeValue: 0
    });
  });

  it("marks only the requested conversation read when the pressed action has no tracked message", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });
    tracker.registerResponse({
      responseId: "response-2",
      conversationId: "conversation-2",
      response: response(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.resolveAction({
      conversationId: "conversation-1",
      messageId: "webview-only-message",
      action: "runCommand",
      markRead: true
    })).toMatchObject({
      unreadResponses: 1,
      pendingProcesses: 0,
      badgeValue: 1
    });
  });

  it("clears an unread conversation-only activity when its action button is pressed", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });

    expect(tracker.resolveAction({
      conversationId: "conversation-1",
      messageId: "webview-only-message",
      action: "runCommand",
      markRead: true
    })).toMatchObject({
      unreadResponses: 0,
      pendingProcesses: 0,
      badgeValue: 0
    });
  });

  it("clears the badge after all pending processes are resolved", () => {
    const tracker = new MentorActivityTracker();
    tracker.registerResponse({
      responseId: "response-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      response: response(),
      hintLevel: "high",
      unread: true
    });
    tracker.markAllRead();
    tracker.resolveAction({
      conversationId: "conversation-1",
      messageId: "message-1",
      action: "applyPatch"
    });

    expect(tracker.resolveAction({
      conversationId: "conversation-1",
      messageId: "message-1",
      action: "runCommand"
    })).toMatchObject({
      unreadResponses: 0,
      pendingProcesses: 0,
      badgeValue: 0
    });
  });
});
