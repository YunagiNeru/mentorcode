import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CommandExecutionResult,
  ConversationContext,
  ConversationContextAction,
  ConversationContextAssistantActionSummary,
  ConversationContextCommandResult,
  ConversationContextEditResult,
  ConversationContextMessage,
  MentorHintLevel,
  MentorRequest,
  MentorResponse,
  MentorToolActionKind
} from "../domain/types";
import {
  commandToolCall,
  commandToolCallTargetPaths,
  mcpToolCall,
  patchToolCall,
  patchToolCallTargetPaths
} from "../domain/agent/toolCalls";
import { MentorRequestGuard } from "../domain/privacy/mentorRequestGuard";
import { PrivacyGuard } from "../domain/privacy/privacyGuard";
import type { WorkspaceReference } from "./workspaceScanner";

const CONVERSATION_SCHEMA_VERSION = 1;
const INDEX_FILE_NAME = "index.v1.json";
const RECENT_CONTEXT_MESSAGE_LIMIT = 8;

export type PersistedConversationAction = MentorToolActionKind;

export interface PersistedConversationSummary {
  readonly conversationId: string;
  readonly workspaceKey: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
}

export type PersistedConversationMessage =
  | {
    readonly id: string;
    readonly kind: "user";
    readonly createdAt: string;
    readonly text: string;
    readonly references: readonly WorkspaceReference[];
    readonly workspaceInspection: boolean;
  }
  | {
    readonly id: string;
    readonly kind: "assistant";
    readonly createdAt: string;
    readonly hintLevel?: MentorHintLevel;
    readonly response: MentorResponse;
    readonly approvedActions?: readonly PersistedConversationAction[];
  };

export interface PersistedConversation {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly workspaceKey: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hintLevel: MentorHintLevel;
  readonly messages: readonly PersistedConversationMessage[];
}

export interface ConversationState {
  readonly currentConversationId: string;
  readonly conversations: readonly PersistedConversationSummary[];
  readonly current: PersistedConversation;
}

interface ConversationIndex {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly conversations: readonly PersistedConversationSummary[];
}

export interface ConversationStoreOptions {
  readonly workspaceKey: string;
  readonly guard?: PrivacyGuard;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface AppendUserMessageInput {
  readonly conversationId?: string;
  readonly startNewConversation?: boolean;
  readonly messageId?: string;
  readonly request: MentorRequest;
  readonly references: readonly WorkspaceReference[];
  readonly workspaceInspection: boolean;
}

export class ConversationStore {
  private readonly contextGuard: PrivacyGuard;
  private readonly requestGuard: MentorRequestGuard;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private currentConversationId: string | undefined;

  public constructor(
    private readonly storageRoot: string,
    private readonly options: ConversationStoreOptions
  ) {
    this.contextGuard = options.guard ?? new PrivacyGuard();
    this.requestGuard = new MentorRequestGuard(this.contextGuard);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public static workspaceKeyFromSource(source: string): string {
    return createHash("sha256").update(source || "empty-workspace").digest("hex");
  }

  public async initialState(): Promise<ConversationState> {
    const conversations = await this.workspaceSummaries();
    const existing = conversations[0];
    if (existing) {
      return this.loadConversation(existing.conversationId);
    }

    return this.createConversation();
  }

  public async createConversation(): Promise<ConversationState> {
    const now = this.isoNow();
    const conversation: PersistedConversation = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      conversationId: this.idFactory(),
      workspaceKey: this.options.workspaceKey,
      title: "新しいチャット",
      createdAt: now,
      updatedAt: now,
      hintLevel: "low",
      messages: []
    };

    await this.saveConversation(conversation);
    this.currentConversationId = conversation.conversationId;
    return this.stateForConversation(conversation);
  }

  public async loadConversation(conversationId: string): Promise<ConversationState> {
    const conversation = await this.readConversation(conversationId);
    if (!conversation || conversation.workspaceKey !== this.options.workspaceKey) {
      return this.initialState();
    }

    this.currentConversationId = conversation.conversationId;
    return this.stateForConversation(conversation);
  }

  public async updateSettings(input: {
    readonly conversationId?: string;
    readonly hintLevel?: MentorHintLevel;
  }): Promise<ConversationState> {
    const conversation = await this.conversationForMutation(input.conversationId);
    const updated: PersistedConversation = {
      ...conversation,
      ...(input.hintLevel ? { hintLevel: input.hintLevel } : {}),
      updatedAt: this.isoNow()
    };
    await this.saveConversation(updated);
    return this.stateForConversation(updated);
  }

  public async appendUserMessage(input: AppendUserMessageInput): Promise<ConversationState> {
    const conversation = await this.conversationForMutation(input.conversationId, {
      startNewConversation: Boolean(input.startNewConversation)
    });
    const decision = await this.requestGuard.sanitize(input.request);
    if (!decision.accepted) {
      throw new Error(decision.reason);
    }

    const now = this.isoNow();
    const text = decision.request.task;
    const message: PersistedConversationMessage = {
      id: input.messageId ?? this.idFactory(),
      kind: "user",
      createdAt: now,
      text,
      references: input.references,
      workspaceInspection: input.workspaceInspection
    };
    const updated: PersistedConversation = {
      ...conversation,
      title: conversation.messages.length === 0 ? this.titleFromText(text) : conversation.title,
      updatedAt: now,
      ...(decision.request.hintLevel ? { hintLevel: this.normalizeHintLevel(decision.request.hintLevel) } : {}),
      messages: [
        ...conversation.messages,
        message
      ]
    };

    await this.saveConversation(updated);
    return this.stateForConversation(updated);
  }

  public async appendAssistantMessage(input: {
    readonly conversationId?: string;
    readonly hintLevel?: MentorRequest["hintLevel"];
    readonly response: MentorResponse;
  }): Promise<ConversationState> {
    const conversation = await this.conversationForMutation(input.conversationId);
    const now = this.isoNow();
    const message: PersistedConversationMessage = {
      id: this.idFactory(),
      kind: "assistant",
      createdAt: now,
      hintLevel: this.normalizeHintLevel(input.hintLevel ?? conversation.hintLevel),
      response: input.response
    };
    const updated: PersistedConversation = {
      ...conversation,
      updatedAt: now,
      messages: [
        ...conversation.messages,
        message
      ]
    };

    await this.saveConversation(updated);
    return this.stateForConversation(updated);
  }

  public async markMessageActionApproved(input: {
    readonly conversationId?: string;
    readonly messageId: string;
    readonly action: PersistedConversationAction;
  }): Promise<ConversationState> {
    const conversation = await this.conversationForMutation(input.conversationId);
    const updated: PersistedConversation = {
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (message.id !== input.messageId || message.kind !== "assistant") {
          return message;
        }

        const approvedActions = new Set(message.approvedActions ?? []);
        approvedActions.add(input.action);
        return {
          ...message,
          approvedActions: [...approvedActions]
        };
      })
    };

    await this.saveConversation(updated);
    return this.stateForConversation(updated);
  }

  public buildContext(
    conversation: PersistedConversation,
    input: {
      readonly lastCommandResult?: CommandExecutionResult;
      readonly lastEditResult?: ConversationContextEditResult;
    } = {}
  ): ConversationContext {
    const recentMessages = conversation.messages
      .slice(-RECENT_CONTEXT_MESSAGE_LIMIT)
      .map((message) => this.contextMessage(message));
    const olderMessages = conversation.messages.slice(0, Math.max(0, conversation.messages.length - RECENT_CONTEXT_MESSAGE_LIMIT));
    const approvedActions = conversation.messages.flatMap((message) => this.contextActions(message));
    const lastAssistantActionSummary = this.lastAssistantActionSummary(conversation.messages);
    const originalGoal = conversation.messages.find((message) => message.kind === "user");
    const compactedSummary = olderMessages.length > 0 ? this.compactedSummary(olderMessages) : undefined;

    return {
      conversationId: conversation.conversationId,
      title: this.safeText("conversation-context/title.txt", conversation.title, 160),
      ...(originalGoal?.kind === "user"
        ? { originalGoal: this.safeText("conversation-context/original-goal.txt", originalGoal.text, 800) }
        : {}),
      ...(compactedSummary ? { compactedSummary } : {}),
      ...(olderMessages.length > 0
        ? {
          compaction: {
            strategy: "deterministic_summary",
            totalMessages: conversation.messages.length,
            compactedMessages: olderMessages.length,
            recentMessageLimit: RECENT_CONTEXT_MESSAGE_LIMIT
          }
        }
        : {}),
      recentMessages,
      approvedActions,
      ...(lastAssistantActionSummary ? { lastAssistantActionSummary } : {}),
      ...(input.lastEditResult ? { lastEditResult: this.contextEditResult(input.lastEditResult) } : {}),
      ...(input.lastCommandResult ? { lastCommandResult: this.contextCommandResult(input.lastCommandResult) } : {})
    };
  }

  private async conversationForMutation(
    conversationId: string | undefined,
    options: { readonly startNewConversation?: boolean } = {}
  ): Promise<PersistedConversation> {
    if (options.startNewConversation) {
      const state = await this.createConversation();
      return state.current;
    }

    const targetId = conversationId ?? this.currentConversationId;
    if (targetId) {
      const existing = await this.readConversation(targetId);
      if (existing && existing.workspaceKey === this.options.workspaceKey) {
        this.currentConversationId = existing.conversationId;
        return existing;
      }
    }

    const state = await this.createConversation();
    return state.current;
  }

  private async stateForConversation(conversation: PersistedConversation): Promise<ConversationState> {
    return {
      currentConversationId: conversation.conversationId,
      conversations: await this.workspaceSummaries(),
      current: conversation
    };
  }

  private async saveConversation(conversation: PersistedConversation): Promise<void> {
    await this.writeJson(this.conversationPath(conversation.conversationId), conversation);
    await this.upsertSummary(this.summaryFromConversation(conversation));
  }

  private async upsertSummary(summary: PersistedConversationSummary): Promise<void> {
    const index = await this.readIndex();
    const summaries = [
      summary,
      ...index.conversations.filter((item) => item.conversationId !== summary.conversationId)
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await this.writeJson(this.indexPath(), {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      conversations: summaries
    } satisfies ConversationIndex);
  }

  private summaryFromConversation(conversation: PersistedConversation): PersistedConversationSummary {
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    return {
      conversationId: conversation.conversationId,
      workspaceKey: conversation.workspaceKey,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      lastMessagePreview: lastMessage ? this.previewFromMessage(lastMessage) : ""
    };
  }

  private previewFromMessage(message: PersistedConversationMessage): string {
    if (message.kind === "user") {
      return this.titleFromText(message.text);
    }

    return this.titleFromText(message.response.title);
  }

  private async workspaceSummaries(): Promise<readonly PersistedConversationSummary[]> {
    const index = await this.readIndex();
    return index.conversations
      .filter((item) => item.workspaceKey === this.options.workspaceKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async readConversation(conversationId: string): Promise<PersistedConversation | undefined> {
    const parsed = await this.readJson<unknown>(this.conversationPath(conversationId));
    if (!this.isConversation(parsed)) {
      return undefined;
    }

    return parsed;
  }

  private async readIndex(): Promise<ConversationIndex> {
    const parsed = await this.readJson<unknown>(this.indexPath());
    if (!this.isIndex(parsed)) {
      return {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        conversations: []
      };
    }

    return parsed;
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf-8")) as T;
    } catch {
      return undefined;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await rename(tempPath, path);
  }

  private conversationPath(conversationId: string): string {
    return join(this.storageRoot, "conversations", "workspaces", this.options.workspaceKey, `${conversationId}.json`);
  }

  private indexPath(): string {
    return join(this.storageRoot, "conversations", INDEX_FILE_NAME);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private titleFromText(text: string): string {
    const title = text.replace(/\s+/g, " ").trim();
    if (!title) {
      return "新しいチャット";
    }

    return title.length > 48 ? `${title.slice(0, 45)}...` : title;
  }

  private normalizeHintLevel(value: MentorRequest["hintLevel"]): MentorHintLevel {
    if (value === "medium" || value === "high" || value === "very_high") {
      return value;
    }

    return "low";
  }

  private contextMessage(message: PersistedConversationMessage): ConversationContextMessage {
    if (message.kind === "user") {
      return {
        role: "user",
        createdAt: message.createdAt,
        text: this.safeText("conversation-context/user-message.txt", message.text, 1200)
      };
    }

    return {
      role: "assistant",
      createdAt: message.createdAt,
      text: this.safeText("conversation-context/assistant-message.txt", this.assistantSummary(message.response), 1600),
      ...(message.approvedActions && message.approvedActions.length > 0 ? { approvedActions: message.approvedActions } : {})
    };
  }

  private contextActions(message: PersistedConversationMessage): readonly ConversationContextAction[] {
    if (message.kind !== "assistant" || !message.approvedActions || message.approvedActions.length === 0) {
      return [];
    }

    return message.approvedActions.map((action) => ({
      messageId: message.id,
      kind: action,
      status: "approved",
      summary: this.safeText(
        "conversation-context/approved-action.txt",
        this.actionSummary(message.response, action),
        600
      ),
      targets: this.actionTargets(message.response, action)
    }));
  }

  private lastAssistantActionSummary(
    messages: readonly PersistedConversationMessage[]
  ): ConversationContextAssistantActionSummary | undefined {
    for (const message of [...messages].reverse()) {
      if (message.kind !== "assistant") {
        continue;
      }

      const patch = patchToolCall(message.response);
      const command = commandToolCall(message.response);
      const mcp = mcpToolCall(message.response);
      if (!patch && !command && !mcp) {
        continue;
      }

      return {
        messageId: message.id,
        title: this.safeText("conversation-context/assistant-action-title.txt", message.response.title, 160),
        ...(patch ? { editIntent: this.safeText("conversation-context/edit-intent.txt", patch.intent, 400) } : {}),
        editTargets: patch ? patchToolCallTargetPaths(patch).slice(0, 20) : [],
        ...(command ? { command: this.safeText("conversation-context/command.txt", command.command, 500) } : {}),
        ...(command
          ? {
            commandExpectedResult: this.safeText(
              "conversation-context/command-expected-result.txt",
              command.expectedResult,
              500
            )
          }
          : {}),
        ...(mcp
          ? {
            mcpTool: this.safeText("conversation-context/mcp-tool.txt", `${mcp.serverId}:${mcp.toolName}`, 500),
            mcpExpectedResult: this.safeText(
              "conversation-context/mcp-expected-result.txt",
              mcp.expectedResult,
              500
            )
          }
          : {})
      };
    }

    return undefined;
  }

  private contextCommandResult(result: CommandExecutionResult): ConversationContextCommandResult {
    return {
      shell: result.shell,
      command: this.safeText("conversation-context/command-result-command.txt", result.command, 500),
      workingDirectory: this.safeText("conversation-context/command-result-working-directory.txt", result.workingDirectory, 300),
      exitCode: result.exitCode,
      stdout: this.safeText("conversation-context/command-result-stdout.txt", result.stdout, 6000),
      stderr: this.safeText("conversation-context/command-result-stderr.txt", result.stderr, 4000),
      safetyNotice: this.safeText("conversation-context/command-result-safety.txt", result.safetyNotice, 600)
    };
  }

  private contextEditResult(result: ConversationContextEditResult): ConversationContextEditResult {
    return {
      ...(result.assistantMessageId
        ? { assistantMessageId: this.safeText("conversation-context/edit-result-assistant-message.txt", result.assistantMessageId, 160) }
        : {}),
      appliedFiles: result.appliedFiles
        .map((path) => this.safeText("conversation-context/edit-result-file.txt", path, 300))
        .slice(0, 40),
      operationCount: result.operationCount,
      message: this.safeText("conversation-context/edit-result-message.txt", result.message, 600),
      ...(result.stdout
        ? { stdout: this.safeText("conversation-context/edit-result-stdout.txt", result.stdout, 3000) }
        : {}),
      ...(result.stderr
        ? { stderr: this.safeText("conversation-context/edit-result-stderr.txt", result.stderr, 3000) }
        : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {})
    };
  }

  private compactedSummary(messages: readonly PersistedConversationMessage[]): string {
    const parts = messages.map((message) => {
      if (message.kind === "user") {
        return `user: ${this.titleFromText(message.text)}`;
      }

      const patch = patchToolCall(message.response);
      const command = commandToolCall(message.response);
      const mcp = mcpToolCall(message.response);
      const targets = [
        ...(patch ? patchToolCallTargetPaths(patch) : []),
        ...(command ? [command.command] : []),
        ...(mcp ? [`${mcp.serverId}:${mcp.toolName}`] : [])
      ];
      const suffix = targets.length > 0 ? ` / actions: ${targets.slice(0, 6).join(", ")}` : "";
      return `assistant: ${this.titleFromText(message.response.title)}${suffix}`;
    });

    return this.safeText("conversation-context/compacted-summary.txt", parts.join("\n"), 2000);
  }

  private assistantSummary(response: MentorResponse): string {
    const sections = response.sections.slice(0, 4).map((section) => {
      const items = section.items.slice(0, 4).map((item) => this.titleFromText(item)).join(" / ");
      return `${section.heading}: ${items}`;
    });
    const patch = patchToolCall(response);
    const command = commandToolCall(response);
    const mcp = mcpToolCall(response);
    const editTargets = patch ? patchToolCallTargetPaths(patch).slice(0, 20) : [];

    return [
      response.title,
      ...sections,
      editTargets.length > 0 ? `editTargets: ${editTargets.join(", ")}` : "",
      command ? `command: ${command.command}` : "",
      mcp ? `mcpTool: ${mcp.serverId}:${mcp.toolName}` : ""
    ].filter((line) => line.length > 0).join("\n");
  }

  private actionSummary(response: MentorResponse, action: PersistedConversationAction): string {
    if (action === "applyPatch") {
      return patchToolCall(response)?.intent ?? "編集案が承認済みです。";
    }

    if (action === "mcpTool") {
      const mcp = mcpToolCall(response);
      return mcp
        ? `${mcp.serverId}:${mcp.toolName}\n${mcp.expectedResult}`
        : "MCP Tool案が承認済みです。";
    }

    const command = commandToolCall(response);
    return command
      ? `${command.command}\n${command.expectedResult}`
      : "コマンド案が承認済みです。";
  }

  private actionTargets(response: MentorResponse, action: PersistedConversationAction): readonly string[] {
    if (action === "applyPatch") {
      const patch = patchToolCall(response);
      return patch ? patchToolCallTargetPaths(patch).slice(0, 20) : [];
    }

    if (action === "mcpTool") {
      const mcp = mcpToolCall(response);
      return mcp ? [`${mcp.serverId}:${mcp.toolName}`] : [];
    }

    const command = commandToolCall(response);
    return command ? commandToolCallTargetPaths(command) : [];
  }

  private safeText(path: string, content: string, maxLength: number): string {
    const result = this.contextGuard.analyzeFile({
      path,
      content: this.truncate(content, maxLength),
      sizeBytes: new TextEncoder().encode(content).byteLength
    });

    if (result.blocked || result.excluded || result.maskedContent === undefined) {
      return `[Privacy Guard redacted conversation context: ${result.excludeReason ?? "unsafe content"}]`;
    }

    return result.maskedContent;
  }

  private truncate(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    return `${content.slice(0, maxLength)}\n[conversation context truncated after ${maxLength} chars]`;
  }

  private isIndex(value: unknown): value is ConversationIndex {
    if (!this.isRecord(value)) {
      return false;
    }

    return value.schemaVersion === CONVERSATION_SCHEMA_VERSION && Array.isArray(value.conversations);
  }

  private isConversation(value: unknown): value is PersistedConversation {
    if (!this.isRecord(value)) {
      return false;
    }

    return (
      value.schemaVersion === CONVERSATION_SCHEMA_VERSION &&
      typeof value.conversationId === "string" &&
      typeof value.workspaceKey === "string" &&
      typeof value.title === "string" &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string" &&
      Array.isArray(value.messages)
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}
