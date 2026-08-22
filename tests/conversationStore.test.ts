import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import type { CommandExecutionResult } from "../src/domain/types";
import { ConversationStore } from "../src/extension/conversationStore";

let tempRoot: string | undefined;

async function createTempRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "mentor-conversations-"));
  return tempRoot;
}

function idFactory(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

describe("ConversationStore", () => {
  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("persists masked user messages as JSON and restores them", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    const initial = await store.initialState();
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";

    await store.appendUserMessage({
      conversationId: initial.currentConversationId,
      messageId: "message-1",
      request: {
        task: `このAPIキーを確認して ${fakeKey}`,
        hintLevel: "high"
      },
      references: [
        {
          path: "src/index.ts",
          kind: "file"
        }
      ],
      workspaceInspection: false
    });

    const conversationPath = join(root, "conversations", "workspaces", workspaceKey, `${initial.currentConversationId}.json`);
    const saved = await readFile(conversationPath, "utf-8");
    expect(saved).not.toContain(fakeKey);
    expect(saved).toContain("__OPENAI_API_KEY_1__");

    const restored = await new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard()
    }).initialState();
    expect(restored.current.messages).toHaveLength(1);
    expect(restored.current.messages[0]).toMatchObject({
      kind: "user",
      text: expect.stringContaining("__OPENAI_API_KEY_1__")
    });
    expect(restored.current.hintLevel).toBe("high");
    expect(restored.conversations[0]?.title).toContain("__OPENAI_API_KEY_1__");
  });

  it("stores assistant responses in the same conversation", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    const initial = await store.initialState();

    await store.appendUserMessage({
      conversationId: initial.currentConversationId,
      messageId: "message-1",
      request: {
        task: "src/index.ts を確認してください"
      },
      references: [],
      workspaceInspection: false
    });
    const updated = await store.appendAssistantMessage({
      conversationId: initial.currentConversationId,
      hintLevel: "high",
      response: {
        title: "メンター応答",
        sections: [
          {
            heading: "確認",
            items: ["マスク済みコンテキストだけを使います。"]
          }
        ],
        policyWarnings: []
      }
    });

    expect(updated.current.messages).toHaveLength(2);
    expect(updated.current.messages[1]).toMatchObject({
      id: "id-2",
      kind: "assistant",
      hintLevel: "high",
      response: {
        title: "メンター応答"
      }
    });
  });

  it("starts a separate conversation when requested from the initial task list", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    const initial = await store.initialState();

    await store.appendUserMessage({
      conversationId: initial.currentConversationId,
      messageId: "message-1",
      request: {
        task: "既存チャットの相談"
      },
      references: [],
      workspaceInspection: false
    });

    const next = await store.appendUserMessage({
      conversationId: initial.currentConversationId,
      startNewConversation: true,
      messageId: "message-2",
      request: {
        task: "初期表示から送った新しい相談",
        hintLevel: "very_high"
      },
      references: [],
      workspaceInspection: false
    });

    expect(next.currentConversationId).not.toBe(initial.currentConversationId);
    expect(next.current.title).toBe("初期表示から送った新しい相談");
    expect(next.current.hintLevel).toBe("very_high");
    expect(next.current.messages).toHaveLength(1);
    expect(next.current.messages[0]).toMatchObject({
      kind: "user",
      text: "初期表示から送った新しい相談"
    });

    const original = await store.loadConversation(initial.currentConversationId);
    expect(original.current.messages).toHaveLength(1);
    expect(original.current.messages[0]).toMatchObject({
      kind: "user",
      text: "既存チャットの相談"
    });
  });

  it("persists approved assistant actions across store reloads", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    const initial = await store.initialState();
    const withAssistant = await store.appendAssistantMessage({
      conversationId: initial.currentConversationId,
      hintLevel: "very_high",
      response: {
        title: "実装案",
        sections: [
          {
            heading: "次の操作",
            items: ["編集案を適用できます。"]
          }
        ],
        policyWarnings: []
      }
    });
    const assistantMessage = withAssistant.current.messages.find((message) => message.kind === "assistant");
    expect(assistantMessage).toBeDefined();

    await store.markMessageActionApproved({
      conversationId: initial.currentConversationId,
      messageId: assistantMessage?.id ?? "",
      action: "applyPatch"
    });

    const restored = await new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard()
    }).loadConversation(initial.currentConversationId);
    expect(restored.current.messages[0]).toMatchObject({
      kind: "assistant",
      hintLevel: "very_high",
      approvedActions: ["applyPatch"]
    });
  });

  it("builds a bounded conversation context without replaying full edit bodies", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    const initial = await store.initialState();
    const userState = await store.appendUserMessage({
      conversationId: initial.currentConversationId,
      messageId: "message-1",
      request: {
        task: "Reactのタスク管理アプリを作ってください",
        hintLevel: "very_high"
      },
      references: [],
      workspaceInspection: false
    });
    const assistantState = await store.appendAssistantMessage({
      conversationId: userState.currentConversationId,
      hintLevel: "very_high",
      response: {
        title: "編集案",
        sections: [
          {
            heading: "方針",
            items: ["App.tsxを更新し、ビルドで検証します。"]
          }
        ],
        policyWarnings: [],
        toolCalls: [
          {
            type: "apply_patch",
            intent: "タスク管理UIを追加します。",
            patch: [
              "*** Begin Patch",
              "*** Update File: src/App.tsx",
              "@@",
              "-export default function App() {}",
              "+SHOULD_NOT_BE_REPLAYED_IN_CONTEXT",
              "*** End Patch"
            ].join("\n")
          },
          {
            type: "run_command",
            shell: "bash",
            command: "npm run build",
            workingDirectory: ".",
            meaning: "型チェックとビルドを実行します。",
            expectedResult: "exitCode 0 で完了します。"
          },
          {
            type: "mcp_tool",
            serverId: "project-tools",
            toolName: "lookup",
            arguments: { id: "one" },
            intent: "対象を確認します。",
            expectedResult: "対象の情報を取得します。"
          }
        ]
      }
    });
    const assistantMessage = assistantState.current.messages.find((message) => message.kind === "assistant");
    await store.markMessageActionApproved({
      conversationId: assistantState.currentConversationId,
      messageId: assistantMessage?.id ?? "",
      action: "applyPatch"
    });
    const fullyApprovedState = await store.markMessageActionApproved({
      conversationId: assistantState.currentConversationId,
      messageId: assistantMessage?.id ?? "",
      action: "mcpTool"
    });
    const commandResult: CommandExecutionResult = {
      shell: "bash",
      command: "npm run build",
      workingDirectory: "C:\\workspace\\project",
      exitCode: 0,
      stdout: "build succeeded",
      stderr: "",
      safetySummary: {
        scannedFiles: 2,
        includedFiles: 2,
        blockedFiles: 0,
        maskedFindings: 0,
        warningFindings: 0,
        criticalFindings: 0
      },
      safetyNotice: "コマンド出力はPrivacy Guardで検査済みです。"
    };

    const context = store.buildContext(fullyApprovedState.current, {
      lastEditResult: {
        assistantMessageId: assistantMessage?.id ?? "",
        appliedFiles: ["src/App.tsx"],
        operationCount: 1,
        message: "編集案を 1 件の操作として適用しました。"
      },
      lastCommandResult: commandResult
    });
    const serialized = JSON.stringify(context);

    expect(context.conversationId).toBe(initial.currentConversationId);
    expect(context.originalGoal).toContain("Reactのタスク管理アプリ");
    expect(context.recentMessages).toHaveLength(2);
    expect(context.approvedActions[0]).toMatchObject({
      kind: "applyPatch",
      status: "approved",
      targets: ["src/App.tsx"]
    });
    expect(context.approvedActions[1]).toMatchObject({
      kind: "mcpTool",
      status: "approved",
      targets: ["project-tools:lookup"]
    });
    expect(context.lastAssistantActionSummary).toMatchObject({
      editTargets: ["src/App.tsx"],
      command: "npm run build",
      mcpTool: "project-tools:lookup"
    });
    expect(context.lastEditResult).toMatchObject({
      assistantMessageId: assistantMessage?.id,
      appliedFiles: ["src/App.tsx"],
      operationCount: 1
    });
    expect(context.lastCommandResult).toMatchObject({
      command: "npm run build",
      exitCode: 0,
      stdout: "build succeeded"
    });
    expect(serialized).not.toContain("SHOULD_NOT_BE_REPLAYED_IN_CONTEXT");
  });

  it("compacts older messages while keeping the recent tail detailed", async () => {
    const root = await createTempRoot();
    const workspaceKey = ConversationStore.workspaceKeyFromSource("file:///workspace/project");
    const store = new ConversationStore(root, {
      workspaceKey,
      guard: new PrivacyGuard(),
      idFactory: idFactory()
    });
    let state = await store.initialState();

    for (let index = 0; index < 10; index += 1) {
      state = await store.appendUserMessage({
        conversationId: state.currentConversationId,
        messageId: `message-${index}`,
        request: {
          task: `質問${index}`,
          hintLevel: "high"
        },
        references: [],
        workspaceInspection: false
      });
    }

    const context = store.buildContext(state.current);

    expect(context.recentMessages).toHaveLength(8);
    expect(context.recentMessages[0]?.text).toBe("質問2");
    expect(context.compaction).toEqual({
      strategy: "deterministic_summary",
      totalMessages: 10,
      compactedMessages: 2,
      recentMessageLimit: 8
    });
    expect(context.compactedSummary).toContain("質問0");
    expect(context.compactedSummary).toContain("質問1");
  });
});
