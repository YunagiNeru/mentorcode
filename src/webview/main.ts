import "./styles.css";
import "@phosphor-icons/webcomponents/PhArrowLeft";
import "@phosphor-icons/webcomponents/PhArrowUp";
import "@phosphor-icons/webcomponents/PhCaretDown";
import "@phosphor-icons/webcomponents/PhCheckCircle";
import "@phosphor-icons/webcomponents/PhClockCounterClockwise";
import "@phosphor-icons/webcomponents/PhCloud";
import "@phosphor-icons/webcomponents/PhCloudCheck";
import "@phosphor-icons/webcomponents/PhCloudX";
import "@phosphor-icons/webcomponents/PhCommand";
import "@phosphor-icons/webcomponents/PhCopySimple";
import "@phosphor-icons/webcomponents/PhFile";
import "@phosphor-icons/webcomponents/PhFolderSimple";
import "@phosphor-icons/webcomponents/PhGearSix";
import "@phosphor-icons/webcomponents/PhKey";
import "@phosphor-icons/webcomponents/PhMagnifyingGlass";
import "@phosphor-icons/webcomponents/PhNotePencil";
import "@phosphor-icons/webcomponents/PhPlus";
import "@phosphor-icons/webcomponents/PhX";
import { CommandPolicy } from "../domain/commands/commandPolicy";
import type { CustomInstructionReviewResult } from "../domain/customInstructionReview";
import type {
  CommandApprovalCard,
  CommandExecutionOutputSnapshot,
  CommandExecutionOutputStream,
  CommandExecutionResult,
  CommandShell,
  ContextPackage,
  EditApplicationResult,
  MentorCommandToolCall,
  MentorContinuation,
  MentorHintLevel,
  MentorMcpToolCall,
  MentorPatchToolCall,
  MentorRequest,
  MentorResponse,
  WorkspaceMap
} from "../domain/types";
import type { McpToolExecutionResult } from "../domain/mcp";
import {
  commandToolCall,
  mcpToolCall,
  manualImplementationTargetPaths,
  patchToolCall,
  patchToolCallTargetPaths,
  patchToolCallToEditPreview,
  requiresManualImplementation
} from "../domain/agent/toolCalls";
import {
  DEFAULT_ACTIVITY_BADGE_ENABLED,
  DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED,
  DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED,
  DEFAULT_SEND_SHORTCUT,
  normalizeBooleanPreference,
  normalizeSendShortcut,
  shouldSubmitComposerOnKeyDown,
  type SendShortcut
} from "../domain/preferences";
import {
  firstBlockingTimelineAction,
  shouldContinueAfterEditApplied,
  shouldRetryAfterPatchApplyFailed,
  type TimelineActionCandidate
} from "./agentLoopPolicy";
import { CommandCardView, ElementFactory, McpToolCardView, MentorResponseView, PreviewView, WorkspaceFileTextRenderer } from "./components";
import { filterMentionedReferences } from "./referenceMentions";
import { VscodeBridge, type WebviewBridgeMessage } from "./vscodeBridge";
import {
  CustomInstructionEditorModel,
  type CustomInstructionSnapshot
} from "./customInstructionEditorModel";
import { CustomInstructionReviewModel } from "./customInstructionReviewModel";
import { CustomInstructionReviewView } from "./customInstructionReviewView";
import { CustomInstructionTextEditor } from "./customInstructionTextEditor";

interface WorkspaceReference {
  readonly path: string;
  readonly kind: "file" | "directory";
}

interface ScanCompletedMessage extends WebviewBridgeMessage {
  readonly type: "scanCompleted";
  readonly result: {
    readonly contextPackage: ContextPackage;
    readonly workspaceMap: WorkspaceMap;
    readonly workspaceTrusted: boolean;
    readonly rootName: string;
  };
}

interface WorkspaceReferencesMessage extends WebviewBridgeMessage {
  readonly type: "workspaceReferences";
  readonly query: string;
  readonly items: readonly WorkspaceReference[];
  readonly message?: string;
}

interface ServerMentorCompletedMessage extends WebviewBridgeMessage {
  readonly type: "serverMentorCompleted";
  readonly result: {
    readonly response: MentorResponse;
    readonly safety: string;
    readonly securityFeedback?: string;
    readonly contextPackage?: ContextPackage;
    readonly conversationId?: string;
    readonly assistantMessageId?: string;
    readonly hintLevel?: MentorHintLevel | number;
  };
}

interface ServerMentorProgressMessage extends WebviewBridgeMessage {
  readonly type: "serverMentorProgress";
  readonly message: string;
  readonly factual?: boolean;
}

interface PatchToolCallResult {
  readonly files: readonly string[];
  readonly operationCount?: number;
  readonly message: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
}

interface PatchToolCallAppliedMessage extends WebviewBridgeMessage {
  readonly type: "patchToolCallApplied";
  readonly messageId?: string;
  readonly result: PatchToolCallResult;
}

interface PatchToolCallFailedMessage extends WebviewBridgeMessage {
  readonly type: "patchToolCallFailed";
  readonly messageId?: string;
  readonly message?: string;
  readonly result?: PatchToolCallResult;
}

interface CommandExecutionCompletedMessage extends WebviewBridgeMessage {
  readonly type: "commandExecutionCompleted";
  readonly messageId?: string;
  readonly result: CommandExecutionResult;
}

interface CommandExecutionOutputMessage extends WebviewBridgeMessage {
  readonly type: "commandExecutionOutput";
  readonly messageId?: string;
  readonly snapshot: CommandExecutionOutputSnapshot;
}

interface CommandExecutionFailedMessage extends WebviewBridgeMessage {
  readonly type: "commandExecutionFailed";
  readonly messageId?: string;
  readonly message?: string;
}

interface CommandExecutionLogState {
  readonly status: "running" | "completed" | "failed";
  readonly shell: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly safetyNotice?: string;
  readonly activeStream?: CommandExecutionOutputStream;
  readonly exitCode?: number | null;
  readonly errorMessage?: string;
  readonly truncated?: boolean;
}

interface PersistedConversationSummary {
  readonly conversationId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly lastMessagePreview: string;
}

type PersistedConversationMessage =
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
    readonly approvedActions?: readonly AssistantApprovalAction[];
  };

interface ConversationStateMessage extends WebviewBridgeMessage {
  readonly type: "conversationState";
  readonly state: {
    readonly currentConversationId: string;
    readonly conversations: readonly PersistedConversationSummary[];
    readonly current: {
      readonly conversationId: string;
      readonly hintLevel: MentorHintLevel;
      readonly messages: readonly PersistedConversationMessage[];
    };
  };
}

interface ConversationSummariesMessage extends WebviewBridgeMessage {
  readonly type: "conversationSummaries";
  readonly conversations: readonly PersistedConversationSummary[];
}

interface ConversationActivatedMessage extends WebviewBridgeMessage {
  readonly type: "conversationActivated";
  readonly conversationId: string;
  readonly title: string;
  readonly conversations: readonly PersistedConversationSummary[];
}

interface AppSettingsMessage extends WebviewBridgeMessage {
  readonly type: "appSettings";
  readonly settings?: {
    readonly sendShortcut?: unknown;
    readonly desktopNotificationsEnabled?: unknown;
    readonly activityBadgeEnabled?: unknown;
    readonly customInstructionsEnabled?: unknown;
    readonly serverTokenConfigured?: unknown;
    readonly serverToken?: unknown;
  };
}

interface ServerTokenValidationMessage extends WebviewBridgeMessage {
  readonly type: "serverTokenValidation";
  readonly status?: unknown;
  readonly requestId?: string;
}

interface ServerTokenMissingMessage extends WebviewBridgeMessage {
  readonly type: "serverTokenMissing";
  readonly message?: unknown;
}

interface ComposerSuggestion {
  readonly label: string;
  readonly insertText: string;
  readonly icon: "file" | "folderSimple" | "plus";
  readonly reference?: WorkspaceReference;
}

interface McpToolExecutionCompletedMessage extends WebviewBridgeMessage {
  readonly type: "mcpToolExecutionCompleted";
  readonly messageId?: string;
  readonly result: McpToolExecutionResult;
}

interface McpToolExecutionFailedMessage extends WebviewBridgeMessage {
  readonly type: "mcpToolExecutionFailed";
  readonly messageId?: string;
  readonly message?: string;
}

interface CustomInstructionDocumentMessage extends WebviewBridgeMessage {
  readonly document: CustomInstructionSnapshot;
  readonly maxBytes?: number;
}

interface CustomInstructionFailureMessage extends WebviewBridgeMessage {
  readonly message?: unknown;
  readonly document?: CustomInstructionSnapshot;
}

interface CustomInstructionReviewResultMessage extends WebviewBridgeMessage {
  readonly type: "customInstructionReviewCompleted";
  readonly revision: string;
  readonly result: CustomInstructionReviewResult;
}

interface CustomInstructionReviewStatusMessage extends WebviewBridgeMessage {
  readonly revision: string;
  readonly message?: unknown;
}

interface ClipboardTextMessage extends WebviewBridgeMessage {
  readonly type: "clipboardText";
  readonly requestId: string;
  readonly text: string;
}

interface CapabilityCatalogMessage extends WebviewBridgeMessage {
  readonly type: "capabilityCatalog";
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description: string; readonly scope: string; readonly source: string; readonly managed: boolean; readonly readme: string }[];
  readonly mcpServers: readonly { readonly id: string; readonly displayName: string; readonly source: string; readonly transport?: string; readonly auth?: string; readonly approved: boolean }[];
  readonly issues: readonly string[];
}

type MessageTone = "info" | "success" | "warning" | "danger";
type ViewMode = "taskList" | "conversation" | "customInstructions" | "capabilities";
type HeaderPopover = "history" | "settings";
type ServerCheckStatus = "idle" | "checking" | "success" | "failed";
type ServerTokenUiStatus = "unknown" | "saved" | "checking" | "valid" | "invalid" | "failed" | "missing";
type AssistantApprovalAction = "applyPatch" | "runCommand" | "mcpTool";
type ServerMentorPendingSource = "user" | "editResult" | "commandResult" | "mcpResult" | "patchRetry";

type ChatMessage =
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
    readonly kind: "system";
    readonly text: string;
    readonly tone: MessageTone;
    readonly linkedFiles?: readonly string[];
  }
  | {
    readonly id: string;
    readonly kind: "securityFeedback";
    readonly text: string;
  }
  | {
    readonly id: string;
    readonly kind: "assistant";
    readonly createdAt: string;
    readonly hintLevel: MentorHintLevel;
    readonly conversationId?: string;
    readonly response: MentorResponse;
    readonly approvedActions: readonly AssistantApprovalAction[];
  }
  | {
    readonly id: string;
    readonly kind: "preview";
    readonly contextPackage: ContextPackage;
    readonly workspaceMap: WorkspaceMap;
  };

interface PendingApproval {
  readonly request: MentorRequest;
  readonly references: readonly WorkspaceReference[];
  readonly userMessageId: string;
  readonly workspaceInspection: boolean;
  readonly startNewConversation: boolean;
}

const HINT_LEVEL_OPTIONS: readonly { readonly value: MentorHintLevel; readonly label: string }[] = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "very_high", label: "非常に高い" }
];
const SEND_SHORTCUT_OPTIONS: readonly { readonly value: SendShortcut; readonly label: string }[] = [
  { value: "ctrlEnter", label: "Ctrl + Enter" },
  { value: "enter", label: "Enter" }
];
const APP_NAME = "Mentor Code";
const APP_LOGO_SRC = new URL("../../media/mentorcode_logo_mark.png", import.meta.url).href;
const ICON_SIZE = 20;
const COMPACT_ICON_SIZE = 14;

const APP_ICON_TAG_NAMES = {
  arrowLeft: "ph-arrow-left",
  arrowUp: "ph-arrow-up",
  caretDown: "ph-caret-down",
  checkCircle: "ph-check-circle",
  clockCounterClockwise: "ph-clock-counter-clockwise",
  cloud: "ph-cloud",
  cloudCheck: "ph-cloud-check",
  cloudX: "ph-cloud-x",
  command: "ph-command",
  copySimple: "ph-copy-simple",
  file: "ph-file",
  folderSimple: "ph-folder-simple",
  gearSix: "ph-gear-six",
  key: "ph-key",
  magnifyingGlass: "ph-magnifying-glass",
  notePencil: "ph-note-pencil",
  plus: "ph-plus",
  x: "ph-x"
} as const;

type AppIconName = keyof typeof APP_ICON_TAG_NAMES;

class MentorChatApplication {
  private readonly factory = new ElementFactory();
  private readonly bridge = new VscodeBridge();
  private readonly linkedText = new WorkspaceFileTextRenderer(this.factory, (path) => this.openWorkspaceFile(path));
  private readonly previewView = new PreviewView(this.factory, (path) => this.openWorkspaceFile(path));
  private readonly mentorView = new MentorResponseView(
    this.factory,
    (path) => this.openWorkspaceFile(path),
    (text) => this.copyText(text)
  );
  private readonly commandView = new CommandCardView(
    this.factory,
    (path) => this.openWorkspaceFile(path),
    (text) => this.copyText(text)
  );
  private readonly mcpToolView = new McpToolCardView(
    this.factory,
    (text) => this.copyText(text)
  );
  private readonly commandPolicy = new CommandPolicy();
  private readonly customInstructionReview = new CustomInstructionReviewModel();
  private readonly customInstructionReviewView = new CustomInstructionReviewView(this.factory);

  private root!: HTMLElement;
  private recentSlot: HTMLElement | undefined;
  private timelineSlot: HTMLElement | undefined;
  private popoverSlot: HTMLElement | undefined;
  private referenceSlot!: HTMLElement;
  private plusMenu!: HTMLElement;
  private contextStatus!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private hintMenuButton!: HTMLButtonElement;
  private hintMenu!: HTMLElement;
  private workspaceOptionButton!: HTMLButtonElement;

  private readonly messages: ChatMessage[] = [];
  private recentTasks: PersistedConversationSummary[] = [];
  private selectedReferences: WorkspaceReference[] = [];
  private referenceSuggestions: readonly ComposerSuggestion[] = [];
  private selectedReferenceSuggestionIndex = 0;
  private referenceQueryRange: { readonly start: number; readonly end: number; readonly query: string } | undefined;
  private pendingApproval: PendingApproval | undefined;
  private workspaceTrusted = true;
  private workspaceInspectionSelected = false;
  private serverMentorPending = false;
  private serverMentorPendingSource: ServerMentorPendingSource | undefined;
  private workspaceScanPending = false;
  private commandExecutionPending = false;
  private hintLevel: MentorHintLevel = "low";
  private sendShortcut: SendShortcut = DEFAULT_SEND_SHORTCUT;
  private desktopNotificationsEnabled = DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED;
  private activityBadgeEnabled = DEFAULT_ACTIVITY_BADGE_ENABLED;
  private customInstructionsEnabled = DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED;
  private serverTokenConfigured = false;
  private serverTokenDraft = "";
  private serverTokenStatus: ServerTokenUiStatus = "unknown";
  private serverTokenValidationRequestId: string | undefined;
  private composerInputHeight = 72;
  private readonly serverProgressTimers: number[] = [];
  private serverMentorProgressLabel: string | undefined;
  private currentConversationId: string | undefined;
  private currentConversationTitle = "新しいチャット";
  private viewMode: ViewMode = "taskList";
  private activePopover: HeaderPopover | undefined;
  private openConversationOnNextState = false;
  private serverCheckStatus: ServerCheckStatus = "idle";
  private serverCheckRequestId: string | undefined;
  private readonly approvedActionKeys = new Set<string>();
  private readonly pendingActionKeys = new Set<string>();
  private readonly continuedActionKeys = new Set<string>();
  private readonly patchApplyRetryKeys = new Set<string>();
  private readonly manualImplementationKeys = new Set<string>();
  private readonly deferredEditResults = new Map<string, EditApplicationResult>();
  private readonly assistantCommandResults = new Map<string, CommandExecutionResult>();
  private readonly commandExecutionLogs = new Map<string, CommandExecutionLogState>();
  private readonly timelineElements = new Map<string, HTMLElement>();
  private readonly dirtyTimelineKeys = new Set<string>();
  private readonly pendingCommandLogRefreshIds = new Set<string>();
  private timelineStateSignature = "";
  private commandLogRefreshFrame: number | undefined;
  private readonly customInstructionEditor = new CustomInstructionEditorModel();
  private customInstructionInput: CustomInstructionTextEditor | undefined;
  private customInstructionStatusSlot: HTMLElement | undefined;
  private customInstructionConflictSlot: HTMLElement | undefined;
  private customInstructionReviewSlot: HTMLElement | undefined;
  private customInstructionReviewButton: HTMLButtonElement | undefined;
  private customInstructionSaveTimer: number | undefined;
  private capabilities: CapabilityCatalogMessage = { type: "capabilityCatalog", skills: [], mcpServers: [], issues: [] };
  private expandedSkillId: string | undefined;
  private readonly pendingClipboardReads = new Map<
    string,
    { readonly resolve: (text: string) => void; readonly timeoutId: number }
  >();

  public start(root: HTMLElement): void {
    this.root = root;
    this.renderShell();
    document.addEventListener("click", (event) => this.handleDocumentClick(event));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.flushCustomInstructionSave();
      }
    });
    window.addEventListener("beforeunload", () => this.flushCustomInstructionSave());
    this.bridge.onMessage((message) => this.handleBridgeMessage(message));
    this.bridge.post({ type: "ready" });
    if (!this.bridge.isVsCode) {
      this.addSystemMessage("チャットから課題を送信できます。必要なファイルは @ で明示し、全送信はローカル検閲後に App Server へ渡します。", "info");
    }
  }

  private renderShell(): void {
    this.customInstructionInput?.dispose();
    this.customInstructionInput = undefined;
    this.factory.clear(this.root);
    this.recentSlot = undefined;
    this.timelineSlot = undefined;
    this.popoverSlot = undefined;

    const shell = this.factory.element("div", `chat-shell chat-shell-${this.viewMode}`);
    const content = this.viewMode === "taskList"
      ? this.renderTaskListView()
      : this.viewMode === "conversation"
        ? this.renderConversationView()
        : this.viewMode === "customInstructions"
          ? this.renderCustomInstructionView()
          : this.renderCapabilitiesView();
    shell.append(this.renderTopBar(), content);
    if (this.viewMode !== "customInstructions" && this.viewMode !== "capabilities") {
      shell.append(this.renderComposer());
    }
    this.root.append(shell);
    if (this.viewMode === "taskList") {
      this.renderRecentTaskItems();
    } else if (this.viewMode === "conversation") {
      this.renderTimelineMessages();
    } else if (this.viewMode === "customInstructions") {
      this.renderCustomInstructionState();
    }
    this.renderComposerState();
    this.renderActivePopover();
  }

  private renderTopBar(): HTMLElement {
    const header = this.factory.element("header", "chat-topbar");
    const left = this.factory.element("div", "topbar-left");
    if (this.viewMode === "conversation") {
      const backButton = this.iconButton("arrowLeft", "back-button", "タスクへ戻る");
      backButton.addEventListener("click", () => this.showTaskList());
      left.append(backButton, this.factory.element("div", "conversation-title", this.currentConversationTitle));
    } else if (this.viewMode === "customInstructions") {
      const backButton = this.iconButton("arrowLeft", "back-button", "タスクへ戻る");
      backButton.addEventListener("click", () => {
        this.flushCustomInstructionSave();
        this.showTaskList();
      });
      left.append(backButton, this.factory.element("div", "conversation-title", "カスタム指示"));
    } else if (this.viewMode === "capabilities") {
      const backButton = this.iconButton("arrowLeft", "back-button", "タスクへ戻る");
      backButton.addEventListener("click", () => this.showTaskList());
      left.append(backButton, this.factory.element("div", "conversation-title", "MCP・Skill"));
    } else {
      left.append(this.factory.element("div", "recent-title", "タスク"));
    }

    const actions = this.factory.element("div", "topbar-actions");
    if (this.viewMode === "customInstructions" || this.viewMode === "capabilities") {
      header.append(left, actions);
      return header;
    }

    const historyButton = this.iconButton("clockCounterClockwise", "icon-button", "履歴");
    historyButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleHeaderPopover("history");
    });
    const settingsButton = this.iconButton("gearSix", "icon-button", "設定");
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleHeaderPopover("settings");
    });
    const newChatButton = this.iconButton("notePencil", "icon-button", "新規チャット");
    newChatButton.addEventListener("click", () => this.startNewChat());
    actions.append(historyButton, settingsButton, newChatButton);
    this.popoverSlot = this.factory.element("div", "topbar-popover-slot");

    header.append(left, actions, this.popoverSlot);
    return header;
  }

  private renderTaskListView(): HTMLElement {
    const section = this.factory.element("main", "task-list-view");
    this.recentSlot = this.factory.element("div", "recent-list");
    const empty = this.factory.element("div", "task-list-empty");
    empty.append(this.renderLogoMark());
    section.append(this.recentSlot, empty);
    return section;
  }

  private renderConversationView(): HTMLElement {
    this.timelineSlot = this.factory.element("main", "chat-timeline");
    return this.timelineSlot;
  }

  private renderCustomInstructionView(): HTMLElement {
    const section = this.factory.element("main", "custom-instruction-view");
    const heading = this.factory.element("div", "custom-instruction-heading");
    heading.append(
      this.factory.element("h2", "custom-instruction-title", "AGENTS.md"),
      this.factory.element(
        "p",
        "custom-instruction-description",
        "すべてのワークスペースで使う共通方針です。アプリの安全規則と現在の具体的な依頼が優先されます。"
      )
    );

    this.customInstructionInput = new CustomInstructionTextEditor(this.factory, {
      initialValue: this.customInstructionEditor.draft,
      placeholder: "カスタム指示を入力してください",
      ariaLabel: "AGENTS.mdを編集",
      onInput: (value) => {
        this.customInstructionEditor.edit(value);
        this.customInstructionReview.draftChanged(value);
        this.scheduleCustomInstructionSave();
        this.renderCustomInstructionState();
      },
      onBlur: () => this.flushCustomInstructionSave(),
      readClipboardText: () => this.readClipboardText()
    });

    this.customInstructionStatusSlot = this.factory.element("div", "custom-instruction-status");
    this.customInstructionStatusSlot.setAttribute("aria-live", "polite");
    this.customInstructionConflictSlot = this.factory.element("div", "custom-instruction-conflict-slot");
    const locationRow = this.factory.element("div", "custom-instruction-location-row");
    const openLocationButton = this.factory.button(
      "",
      "custom-instruction-secondary-button custom-instruction-location-button",
      "カスタム指示の場所を開く"
    );
    openLocationButton.append(
      this.renderIcon("folderSimple", "custom-instruction-location-icon", COMPACT_ICON_SIZE),
      this.factory.element("span", "custom-instruction-location-label", "カスタム指示の場所を開く")
    );
    openLocationButton.addEventListener("click", () => {
      this.bridge.post({ type: "openCustomInstructionLocation" });
    });
    locationRow.append(
      this.factory.element("div", "custom-instruction-path", "~/.mentor-code/AGENTS.md"),
      openLocationButton
    );
    const reviewActions = this.factory.element("div", "custom-instruction-review-actions");
    this.customInstructionReviewButton = this.factory.button(
      "カスタム指示をレビューする",
      "custom-instruction-review-button",
      "カスタム指示をレビューする"
    );
    this.customInstructionReviewButton.addEventListener("click", () => this.requestCustomInstructionReview());
    reviewActions.append(
      this.customInstructionReviewButton,
      this.factory.element(
        "span",
        "custom-instruction-review-note",
        "レビュー候補は自動適用されません。"
      )
    );
    this.customInstructionReviewSlot = this.factory.element("div", "custom-instruction-review-slot");
    this.customInstructionReviewSlot.setAttribute("aria-live", "polite");
    section.append(
      heading,
      locationRow,
      this.customInstructionInput.element,
      this.customInstructionStatusSlot,
      this.customInstructionConflictSlot,
      reviewActions,
      this.customInstructionReviewSlot
    );
    return section;
  }

  private renderCapabilitiesView(): HTMLElement {
    const section = this.factory.element("main", "capability-view");
    const intro = this.factory.element("div", "capability-intro");
    intro.append(
      this.factory.element("h2", "capability-title", "MCP・Skillを管理"),
      this.factory.element("p", "capability-description", "追加前にローカルLLMとApp Serverが内容を監査し、接続・インストールは承認後だけ実行します。")
    );
    const actions = this.factory.element("div", "capability-actions");
    const git = this.factory.button("GitからSkill", "capability-primary-button");
    git.addEventListener("click", () => this.bridge.post({ type: "installSkillFromGit" }));
    const local = this.factory.button("ローカルSkill", "capability-secondary-button");
    local.addEventListener("click", () => this.bridge.post({ type: "installSkillFromLocal" }));
    const mcp = this.factory.button("MCPを追加", "capability-secondary-button");
    mcp.addEventListener("click", () => this.bridge.post({ type: "addMcpServer" }));
    actions.append(git, local, mcp);

    const skillSection = this.factory.element("section", "capability-section");
    skillSection.append(this.factory.element("h3", "capability-section-title", `Skills（${this.capabilities.skills.length}）`));
    const skillList = this.factory.element("div", "capability-list");
    for (const skill of this.capabilities.skills) {
      const card = this.factory.element("article", "capability-card");
      const button = this.factory.button("", "capability-card-header", `$${skill.name} のREADMEを表示`);
      const main = this.factory.element("span", "capability-card-main");
      main.append(this.factory.element("strong", "capability-card-name", `$${skill.name}`), this.factory.element("span", "capability-card-description", skill.description));
      button.append(main, this.factory.element("span", "capability-badge", skill.scope === "workspace" ? "Workspace" : "User"));
      button.addEventListener("click", () => { this.expandedSkillId = this.expandedSkillId === skill.id ? undefined : skill.id; this.renderShell(); });
      card.append(button, this.factory.element("div", "capability-source", skill.source));
      if (this.expandedSkillId === skill.id) {
        const preview = this.factory.element("pre", "capability-readme");
        preview.textContent = skill.readme || "README.mdはありません。";
        const controls = this.factory.element("div", "capability-card-controls");
        if (skill.managed) {
          const update = this.factory.button("更新を確認", "capability-secondary-button");
          update.addEventListener("click", () => this.bridge.post({ type: "updateSkill", skillId: skill.id }));
          controls.append(update);
        }
        const remove = this.factory.button("削除", "capability-danger-button");
        remove.addEventListener("click", () => this.bridge.post({ type: "removeSkill", skillId: skill.id }));
        controls.append(remove);
        card.append(preview, controls);
      }
      skillList.append(card);
    }
    if (this.capabilities.skills.length === 0) skillList.append(this.factory.element("div", "capability-empty", "インストール済みSkillはありません。"));
    skillSection.append(skillList);

    const mcpSection = this.factory.element("section", "capability-section");
    mcpSection.append(this.factory.element("h3", "capability-section-title", `MCP（${this.capabilities.mcpServers.length}）`));
    const mcpList = this.factory.element("div", "capability-list");
    for (const server of this.capabilities.mcpServers) {
      const card = this.factory.element("article", "capability-card capability-mcp-card");
      const row = this.factory.element("div", "capability-card-header");
      const main = this.factory.element("span", "capability-card-main");
      main.append(this.factory.element("strong", "capability-card-name", server.displayName), this.factory.element("span", "capability-card-description", `${server.transport ?? "http"} / ${server.auth ?? "bearer"}`));
      row.append(main, this.factory.element("span", `capability-badge ${server.approved ? "capability-badge-approved" : "capability-badge-warning"}`, server.approved ? "承認済み" : "未承認"));
      const remove = this.factory.button("削除", "capability-danger-button", `${server.displayName}を削除`);
      remove.addEventListener("click", () => this.bridge.post({ type: "removeMcpServer", serverId: server.id }));
      card.append(row, this.factory.element("div", "capability-source", server.source), remove);
      mcpList.append(card);
    }
    if (this.capabilities.mcpServers.length === 0) mcpList.append(this.factory.element("div", "capability-empty", "設定済みMCPはありません。"));
    mcpSection.append(mcpList);
    section.append(intro, actions, skillSection, mcpSection);
    return section;
  }

  private renderComposer(): HTMLElement {
    const wrapper = this.factory.element("footer", "composer-wrapper");
    const composer = this.factory.element("div", "composer");
    const resizeHandle = this.factory.button("", "composer-resize-handle", "入力欄の高さを調整");
    resizeHandle.addEventListener("pointerdown", (event) => this.startComposerResize(event));
    this.input = this.factory.element("textarea", "composer-input") as HTMLTextAreaElement;
    this.input.placeholder = "何でもできます";
    this.input.rows = 3;
    this.input.style.height = `${this.composerInputHeight}px`;
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.addEventListener("input", () => {
      this.syncSelectedReferencesFromInput();
      this.handleReferenceQuery();
      this.renderComposerState();
    });
    this.input.addEventListener("keydown", (event) => {
      if (this.handleReferenceSuggestionKeyDown(event)) {
        return;
      }

      if (shouldSubmitComposerOnKeyDown({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        isComposing: event.isComposing,
        sendShortcut: this.sendShortcut
      })) {
        event.preventDefault();
        void this.submitComposer();
      }
      if (event.key === "Escape") {
        this.clearReferenceSuggestions();
      }
    });

    this.referenceSlot = this.factory.element("div", "reference-suggestions");
    this.referenceSlot.id = "reference-suggestions";
    this.referenceSlot.setAttribute("role", "listbox");
    this.input.setAttribute("aria-controls", this.referenceSlot.id);
    const toolbar = this.factory.element("div", "composer-toolbar");
    const left = this.factory.element("div", "composer-tools");
    const plusButton = this.iconButton("plus", "composer-icon-button", "追加");
    plusButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.togglePlusMenu();
    });
    this.plusMenu = this.renderPlusMenu();

    const hintControl = this.factory.element("div", "hint-menu-control");
    this.hintMenuButton = this.factory.button("", "hint-menu-button", "ヒント段階");
    this.hintMenuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleHintMenu();
    });
    this.hintMenu = this.renderHintMenu();
    hintControl.append(this.hintMenuButton, this.hintMenu);

    this.contextStatus = this.factory.element("div", "context-status");
    left.append(plusButton, this.plusMenu, hintControl, this.contextStatus);
    this.sendButton = this.iconButton("arrowUp", "send-button", "送信");
    this.sendButton.addEventListener("click", () => void this.submitComposer());
    toolbar.append(left, this.sendButton);
    composer.append(resizeHandle, this.input, this.referenceSlot, toolbar);
    wrapper.append(composer);
    return wrapper;
  }

  private iconButton(icon: AppIconName, className: string, title: string): HTMLButtonElement {
    const button = this.factory.button("", className, title);
    button.append(this.renderIcon(icon, "button-icon"));
    return button;
  }

  private renderIcon(icon: AppIconName, className: string, size = ICON_SIZE): HTMLElement {
    return this.factory.phosphorIcon(APP_ICON_TAG_NAMES[icon], className, size);
  }

  private renderLogoMark(): HTMLImageElement {
    const image = this.factory.element("img", "app-logo-mark") as HTMLImageElement;
    image.src = APP_LOGO_SRC;
    image.alt = APP_NAME;
    image.decoding = "async";
    return image;
  }

  private renderPlusMenu(): HTMLElement {
    const menu = this.factory.element("div", "plus-menu plus-menu-hidden");
    this.workspaceOptionButton = this.renderPlusMenuItem("ワークスペース検査");
    this.workspaceOptionButton.addEventListener("click", () => {
      this.workspaceInspectionSelected = !this.workspaceInspectionSelected;
      this.hidePlusMenu();
      this.renderComposerState();
    });

    menu.append(this.workspaceOptionButton);
    return menu;
  }

  private renderPlusMenuItem(label: string): HTMLButtonElement {
    const item = this.factory.button("", "menu-item", label);
    item.append(
      this.factory.element("span", "menu-item-label", label),
      this.renderIcon("checkCircle", "menu-item-check", COMPACT_ICON_SIZE)
    );
    return item;
  }

  private renderHintMenu(): HTMLElement {
    const menu = this.factory.element("div", "hint-menu hint-menu-hidden");
    menu.setAttribute("role", "menu");
    menu.append(this.factory.element("div", "hint-menu-label", "ヒント段階"));

    for (const option of HINT_LEVEL_OPTIONS) {
      const item = this.factory.button("", "hint-menu-item", option.label);
      item.dataset.hintLevel = option.value;
      item.setAttribute("role", "menuitemradio");
      item.append(
        this.factory.element("span", "hint-menu-item-label", option.label),
        this.renderIcon("checkCircle", "hint-menu-check", COMPACT_ICON_SIZE)
      );
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectHintLevel(option.value);
      });
      menu.append(item);
    }

    return menu;
  }

  private renderActivePopover(): void {
    if (!this.popoverSlot) {
      return;
    }

    this.factory.clear(this.popoverSlot);
    if (!this.activePopover) {
      return;
    }

    const popover = this.activePopover === "history"
      ? this.renderHistoryPopover()
      : this.renderSettingsPopover();
    this.popoverSlot.append(popover);
  }

  private renderHistoryPopover(): HTMLElement {
    const popover = this.factory.element("div", "topbar-popover history-popover");
    const searchWrap = this.factory.element("label", "history-search");
    searchWrap.append(
      this.renderIcon("magnifyingGlass", "history-search-icon", COMPACT_ICON_SIZE),
      this.factory.element("input", "history-search-input") as HTMLInputElement
    );
    const searchInput = searchWrap.querySelector("input") as HTMLInputElement | null;
    searchInput?.setAttribute("placeholder", "最近のタスクを検索する");
    searchInput?.setAttribute("aria-label", "最近のタスクを検索する");

    const list = this.factory.element("div", "history-task-list");
    const renderList = (query: string): void => {
      this.factory.clear(list);
      const normalizedQuery = query.trim().toLowerCase();
      const tasks = this.recentTasks.filter((task) => (
        normalizedQuery.length === 0 ||
        task.title.toLowerCase().includes(normalizedQuery) ||
        task.lastMessagePreview.toLowerCase().includes(normalizedQuery)
      ));

      if (tasks.length === 0) {
        list.append(this.factory.element("div", "history-empty", "該当するタスクはありません"));
        return;
      }

      for (const task of tasks) {
        list.append(this.renderTaskButton(task, "history-task"));
      }
    };

    searchInput?.addEventListener("input", () => renderList(searchInput.value));
    renderList("");
    popover.append(searchWrap, list);
    return popover;
  }

  private renderSettingsPopover(): HTMLElement {
    const popover = this.factory.element("div", "topbar-popover settings-popover");
    const heading = this.factory.element("div", "settings-heading", "設定");
    const items = this.factory.element("div", "settings-menu");
    const serverCheckStatus = this.renderServerCheckStatus();
    items.append(
      this.renderSendShortcutSetting(),
      this.renderServerTokenSetting(),
      this.renderBooleanSetting("デスクトップ通知", this.desktopNotificationsEnabled, (enabled) => this.selectDesktopNotificationsEnabled(enabled)),
      this.renderBooleanSetting("バッジ表示", this.activityBadgeEnabled, (enabled) => this.selectActivityBadgeEnabled(enabled)),
      this.renderBooleanSetting("カスタム指示を会話へ適用", this.customInstructionsEnabled, (enabled) => this.selectCustomInstructionsEnabled(enabled)),
      this.renderSettingsItem("notePencil", "カスタム指示を編集する", () => this.openCustomInstructionEditor()),
      this.renderSettingsItem("plus", "MCP・Skillを管理する", () => this.openCapabilities()),
      this.renderSettingsItem("gearSix", "アプリ設定", () => this.bridge.post({ type: "openSettings" })),
      this.renderSettingsItem("command", "キーボードショートカット", () => this.bridge.post({ type: "openKeyboardShortcuts" })),
      this.renderSettingsItem("cloud", "App Server接続確認", () => {
        const requestId = this.nextId();
        this.serverCheckStatus = "checking";
        this.serverCheckRequestId = requestId;
        this.renderActivePopover();
        this.bridge.post({ type: "checkServer", requestId });
      }, {
        keepOpen: true,
        ...(serverCheckStatus ? { trailing: serverCheckStatus } : {})
      })
    );
    popover.append(heading, items);
    return popover;
  }

  private renderSendShortcutSetting(): HTMLElement {
    const group = this.factory.element("div", "settings-choice-group");
    const label = this.factory.element("div", "settings-choice-label", "送信キー");
    const options = this.factory.element("div", "settings-choice-options");

    for (const option of SEND_SHORTCUT_OPTIONS) {
      const item = this.factory.button(option.label, "settings-choice-option", option.label);
      const selected = this.sendShortcut === option.value;
      item.setAttribute("aria-pressed", selected ? "true" : "false");
      item.classList.toggle("settings-choice-option-active", selected);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        this.selectSendShortcut(option.value);
      });
      options.append(item);
    }

    group.append(label, options);
    return group;
  }

  private renderServerTokenSetting(): HTMLElement {
    const group = this.factory.element("div", "settings-token-group");
    const header = this.factory.element("div", "settings-token-header");
    const label = this.factory.element("label", "settings-choice-label", "サーバートークン");
    const inputId = "mentor-code-server-token";
    label.setAttribute("for", inputId);
    header.append(label, this.renderServerTokenStatus());

    const input = this.factory.element("input", "settings-token-input");
    input.id = inputId;
    input.type = "password";
    input.value = this.serverTokenDraft;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = this.serverTokenConfigured
      ? "保存済み。変更する場合は新しいトークンを入力"
      : "App Server token";
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("input", (event) => {
      event.stopPropagation();
      this.serverTokenDraft = input.value;
      this.serverTokenStatus = input.value.trim() ? "saved" : "missing";
      this.bridge.post({ type: "saveServerToken", token: input.value });
    });
    input.addEventListener("blur", () => {
      this.validateServerTokenDraft();
    });

    const note = this.factory.element(
      "p",
      "settings-token-note",
      "入力値は自動保存され、フォーカスが外れた時にApp Serverで検証します。"
    );
    group.append(header, input, note);
    return group;
  }

  private renderServerTokenStatus(): HTMLElement {
    const status = this.currentServerTokenStatus();
    const labels: Record<ServerTokenUiStatus, string> = {
      unknown: "未確認",
      saved: "保存済み",
      checking: "検証中",
      valid: "有効",
      invalid: "無効",
      failed: "接続失敗",
      missing: "未設定"
    };
    const badge = this.factory.element("span", `server-token-status server-token-status-${status}`, labels[status]);
    badge.setAttribute("aria-live", "polite");
    return badge;
  }

  private currentServerTokenStatus(): ServerTokenUiStatus {
    if (this.serverTokenStatus !== "unknown") {
      return this.serverTokenStatus;
    }

    return this.serverTokenConfigured ? "saved" : "missing";
  }

  private renderBooleanSetting(labelText: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
    const group = this.factory.element("div", "settings-choice-group");
    const label = this.factory.element("div", "settings-choice-label", labelText);
    const options = this.factory.element("div", "settings-choice-options");
    const choices: readonly { readonly label: string; readonly value: boolean }[] = [
      { label: "有効", value: true },
      { label: "無効", value: false }
    ];

    for (const choice of choices) {
      const item = this.factory.button(choice.label, "settings-choice-option", `${labelText}: ${choice.label}`);
      const selected = value === choice.value;
      item.setAttribute("aria-pressed", selected ? "true" : "false");
      item.classList.toggle("settings-choice-option-active", selected);
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        onChange(choice.value);
      });
      options.append(item);
    }

    group.append(label, options);
    return group;
  }

  private renderSettingsItem(
    icon: AppIconName,
    label: string,
    action: () => void,
    options: { readonly keepOpen?: boolean; readonly trailing?: HTMLElement } = {}
  ): HTMLButtonElement {
    const item = this.factory.button("", "settings-menu-item", label);
    const main = this.factory.element("span", "settings-menu-main");
    main.append(
      this.renderIcon(icon, "settings-menu-icon", COMPACT_ICON_SIZE),
      this.factory.element("span", "settings-menu-label", label)
    );
    item.append(main);
    if (options.trailing) {
      item.append(options.trailing);
    }
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!options.keepOpen) {
        this.activePopover = undefined;
        this.renderActivePopover();
      }
      action();
    });
    return item;
  }

  private selectSendShortcut(sendShortcut: SendShortcut): void {
    if (this.sendShortcut === sendShortcut) {
      return;
    }

    this.sendShortcut = sendShortcut;
    this.renderActivePopover();
    this.bridge.post({
      type: "updateAppSettings",
      sendShortcut
    });
  }

  private openCustomInstructionEditor(): void {
    this.activePopover = undefined;
    this.viewMode = "customInstructions";
    this.renderShell();
    this.bridge.post({ type: "loadCustomInstruction" });
  }

  private openCapabilities(): void {
    this.activePopover = undefined;
    this.viewMode = "capabilities";
    this.renderShell();
    this.bridge.post({ type: "loadCapabilities" });
  }

  private scheduleCustomInstructionSave(delay = 450): void {
    if (this.customInstructionSaveTimer !== undefined) {
      window.clearTimeout(this.customInstructionSaveTimer);
    }
    this.customInstructionSaveTimer = window.setTimeout(() => {
      this.customInstructionSaveTimer = undefined;
      this.requestCustomInstructionSave();
    }, delay);
  }

  private flushCustomInstructionSave(): void {
    if (this.customInstructionSaveTimer !== undefined) {
      window.clearTimeout(this.customInstructionSaveTimer);
      this.customInstructionSaveTimer = undefined;
    }
    this.requestCustomInstructionSave();
  }

  private requestCustomInstructionSave(): void {
    const request = this.customInstructionEditor.beginSave();
    if (!request) {
      return;
    }
    this.renderCustomInstructionState();
    this.bridge.post({
      type: "saveCustomInstruction",
      ...request
    });
  }

  private requestCustomInstructionReview(): void {
    const preparation = this.customInstructionReview.prepare({
      draft: this.customInstructionEditor.draft,
      revision: this.customInstructionEditor.revision,
      saveStatus: this.customInstructionEditor.status
    });
    if (preparation === "save") {
      this.flushCustomInstructionSave();
      this.renderCustomInstructionState();
      return;
    }
    if (preparation !== "review") {
      this.renderCustomInstructionState();
      return;
    }

    this.renderCustomInstructionState();
    this.bridge.post({
      type: "reviewCustomInstruction",
      revision: this.customInstructionEditor.revision
    });
  }

  private renderCustomInstructionReviewState(): void {
    const active = this.customInstructionReview.isActive();
    if (this.customInstructionReviewButton) {
      this.customInstructionReviewButton.disabled = active ||
        this.customInstructionEditor.status === "loading" ||
        this.customInstructionEditor.status === "too_large" ||
        this.customInstructionEditor.status === "conflict" ||
        !this.customInstructionEditor.draft.trim();
      this.customInstructionReviewButton.textContent = this.customInstructionReview.status === "llm"
        ? "レビューを実行しています"
        : active
          ? "レビューを準備しています"
          : this.customInstructionReview.freshness === "stale"
            ? "現在の内容を再レビューする"
            : "カスタム指示をレビューする";
    }
    if (this.customInstructionReviewSlot) {
      this.customInstructionReviewView.render(this.customInstructionReviewSlot, {
        status: this.customInstructionReview.status,
        message: this.customInstructionReview.message,
        freshness: this.customInstructionReview.freshness,
        ...(this.customInstructionReview.result ? { result: this.customInstructionReview.result } : {})
      });
    }
  }

  private renderCustomInstructionState(): void {
    if (!this.customInstructionStatusSlot) {
      return;
    }

    const labels = {
      loading: "読み込み中",
      saved: "保存済み",
      pending: "保存待ち",
      saving: "保存中",
      conflict: "外部変更と競合",
      too_large: "サイズ上限超過",
      error: "保存失敗"
    } as const;
    this.factory.clear(this.customInstructionStatusSlot);
    this.customInstructionStatusSlot.className = `custom-instruction-status custom-instruction-status-${this.customInstructionEditor.status}`;
    this.customInstructionStatusSlot.append(
      this.factory.element("span", "custom-instruction-status-label", labels[this.customInstructionEditor.status]),
      this.factory.element(
        "span",
        "custom-instruction-byte-count",
        `${this.customInstructionEditor.byteLength.toLocaleString()} / ${this.customInstructionEditor.maxBytes.toLocaleString()} バイト`
      )
    );
    this.renderCustomInstructionReviewState();

    if (!this.customInstructionConflictSlot) {
      return;
    }
    this.factory.clear(this.customInstructionConflictSlot);
    if (this.customInstructionEditor.status === "conflict" && this.customInstructionEditor.conflictSnapshot) {
      const panel = this.factory.element("div", "custom-instruction-conflict");
      panel.append(this.factory.element("p", "custom-instruction-conflict-message", this.customInstructionEditor.errorMessage));
      const actions = this.factory.element("div", "custom-instruction-conflict-actions");
      const reload = this.factory.button("外部変更を読み込む", "custom-instruction-secondary-button", "外部変更を読み込む");
      reload.addEventListener("click", () => {
        this.customInstructionEditor.reloadConflict();
        if (this.customInstructionInput) {
          this.customInstructionInput.setValue(this.customInstructionEditor.draft);
        }
        this.renderCustomInstructionState();
      });
      const overwrite = this.factory.button("編集中内容で上書き", "custom-instruction-danger-button", "編集中内容で上書き");
      overwrite.addEventListener("click", () => {
        this.customInstructionEditor.prepareConflictOverwrite();
        this.requestCustomInstructionSave();
      });
      actions.append(reload, overwrite);
      panel.append(actions);
      this.customInstructionConflictSlot.append(panel);
      return;
    }

    if (this.customInstructionEditor.errorMessage) {
      this.customInstructionConflictSlot.append(
        this.factory.element("p", "custom-instruction-error", this.customInstructionEditor.errorMessage)
      );
    }
  }

  private selectDesktopNotificationsEnabled(enabled: boolean): void {
    if (this.desktopNotificationsEnabled === enabled) {
      return;
    }

    this.desktopNotificationsEnabled = enabled;
    this.renderActivePopover();
    this.bridge.post({
      type: "updateAppSettings",
      desktopNotificationsEnabled: enabled
    });
  }

  private selectActivityBadgeEnabled(enabled: boolean): void {
    if (this.activityBadgeEnabled === enabled) {
      return;
    }

    this.activityBadgeEnabled = enabled;
    this.renderActivePopover();
    this.bridge.post({
      type: "updateAppSettings",
      activityBadgeEnabled: enabled
    });
  }

  private selectCustomInstructionsEnabled(enabled: boolean): void {
    if (this.customInstructionsEnabled === enabled) {
      return;
    }

    this.customInstructionsEnabled = enabled;
    this.renderActivePopover();
    this.bridge.post({
      type: "updateAppSettings",
      customInstructionsEnabled: enabled
    });
  }

  private validateServerTokenDraft(): void {
    const requestId = this.nextId();
    this.serverTokenStatus = "checking";
    this.serverTokenValidationRequestId = requestId;
    this.renderActivePopover();
    this.bridge.post({
      type: "validateServerToken",
      token: this.serverTokenDraft,
      requestId
    });
  }

  private applyAppSettings(message: AppSettingsMessage): void {
    const sendShortcut = normalizeSendShortcut(message.settings?.sendShortcut);
    const desktopNotificationsEnabled = normalizeBooleanPreference(
      message.settings?.desktopNotificationsEnabled,
      DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED
    );
    const activityBadgeEnabled = normalizeBooleanPreference(
      message.settings?.activityBadgeEnabled,
      DEFAULT_ACTIVITY_BADGE_ENABLED
    );
    const customInstructionsEnabled = normalizeBooleanPreference(
      message.settings?.customInstructionsEnabled,
      DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED
    );
    const serverTokenConfigured = Boolean(message.settings?.serverTokenConfigured);
    const serverToken = typeof message.settings?.serverToken === "string" ? message.settings.serverToken : "";
    if (
      this.sendShortcut === sendShortcut &&
      this.desktopNotificationsEnabled === desktopNotificationsEnabled &&
      this.activityBadgeEnabled === activityBadgeEnabled &&
      this.customInstructionsEnabled === customInstructionsEnabled &&
      this.serverTokenConfigured === serverTokenConfigured &&
      this.serverTokenDraft === serverToken
    ) {
      return;
    }

    const previousServerToken = this.serverTokenDraft;
    this.sendShortcut = sendShortcut;
    this.desktopNotificationsEnabled = desktopNotificationsEnabled;
    this.activityBadgeEnabled = activityBadgeEnabled;
    this.customInstructionsEnabled = customInstructionsEnabled;
    this.serverTokenConfigured = serverTokenConfigured;
    this.serverTokenDraft = serverToken;
    if (previousServerToken !== serverToken) {
      this.serverTokenStatus = serverToken ? "saved" : "missing";
    }
    if (!serverTokenConfigured && !this.serverTokenDraft.trim()) {
      this.serverTokenStatus = "missing";
    }
    this.renderActivePopover();
  }

  private renderServerCheckStatus(): HTMLElement | undefined {
    if (this.serverCheckStatus === "idle") {
      return undefined;
    }

    const labels: Record<ServerCheckStatus, { readonly icon?: AppIconName; readonly label: string }> = {
      idle: { label: "" },
      checking: { label: "確認中" },
      success: { icon: "cloudCheck", label: "接続成功" },
      failed: { icon: "cloudX", label: "接続失敗" }
    };
    const status = labels[this.serverCheckStatus];
    const element = this.factory.element("span", `server-check-status server-check-status-${this.serverCheckStatus}`);
    if (status.icon) {
      element.append(this.renderIcon(status.icon, "server-check-icon", 14));
    }
    element.append(this.factory.element("span", "server-check-label", status.label));
    return element;
  }

  private handleBridgeMessage(message: WebviewBridgeMessage): void {
    if (message.type === "clipboardText") {
      const clipboard = message as ClipboardTextMessage;
      const pending = this.pendingClipboardReads.get(clipboard.requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timeoutId);
      pending.resolve(clipboard.text);
      this.pendingClipboardReads.delete(clipboard.requestId);
      return;
    }

    if (message.type === "conversationState") {
      this.applyConversationState(message as ConversationStateMessage);
      return;
    }

    if (message.type === "conversationSummaries") {
      this.recentTasks = [...(message as ConversationSummariesMessage).conversations];
      if (this.currentConversationId) {
        this.currentConversationTitle = this.conversationTitleFor(this.currentConversationId);
      }
      this.renderRecentTaskItems();
      if (this.viewMode === "conversation") {
        this.renderShell();
      }
      return;
    }

    if (message.type === "conversationActivated") {
      const activated = message as ConversationActivatedMessage;
      this.currentConversationId = activated.conversationId;
      this.currentConversationTitle = activated.title;
      this.recentTasks = [...activated.conversations];
      this.renderRecentTaskItems();
      if (this.viewMode === "conversation") {
        this.renderShell();
      }
      return;
    }

    if (message.type === "trustState") {
      this.workspaceTrusted = Boolean(message.workspaceTrusted);
      this.renderComposerState();
      return;
    }

    if (message.type === "appSettings") {
      this.applyAppSettings(message as AppSettingsMessage);
      return;
    }

    if (message.type === "capabilityCatalog") {
      this.capabilities = message as CapabilityCatalogMessage;
      if (this.viewMode === "capabilities") this.renderShell();
      else if (this.input?.value.includes("$")) this.handleReferenceQuery();
      return;
    }

    if (message.type === "customInstructionLoaded") {
      this.customInstructionEditor.load((message as CustomInstructionDocumentMessage).document);
      this.customInstructionReview.draftChanged(this.customInstructionEditor.draft);
      if (this.viewMode === "customInstructions") {
        this.renderShell();
      }
      return;
    }

    if (message.type === "customInstructionSaved") {
      this.customInstructionEditor.applySaved((message as CustomInstructionDocumentMessage).document);
      this.renderCustomInstructionState();
      if (this.customInstructionEditor.status === "pending") {
        this.scheduleCustomInstructionSave(0);
      }
      if (this.customInstructionReview.shouldReviewAfterSave(this.customInstructionEditor.status)) {
        this.requestCustomInstructionReview();
      }
      return;
    }

    if (message.type === "customInstructionSaveFailed") {
      const failed = message as CustomInstructionFailureMessage;
      this.customInstructionEditor.failSave(String(failed.message ?? "自動保存に失敗しました。"), failed.document);
      this.customInstructionReview.saveFailed();
      this.renderCustomInstructionState();
      return;
    }

    if (message.type === "customInstructionLoadFailed" || message.type === "customInstructionLocationOpenFailed") {
      this.customInstructionEditor.failSave(String(message.message ?? "カスタム指示を読み込めませんでした。"));
      this.renderCustomInstructionState();
      return;
    }

    if (message.type === "customInstructionReviewLlmStarted") {
      const started = message as CustomInstructionReviewStatusMessage;
      if (this.customInstructionReview.llmStarted(
        started.revision,
        this.customInstructionEditor.revision,
        this.customInstructionEditor.draft
      )) {
        this.renderCustomInstructionState();
      }
      return;
    }

    if (message.type === "customInstructionReviewUnavailable") {
      const unavailable = message as CustomInstructionReviewStatusMessage;
      if (this.customInstructionReview.unavailable(
        unavailable.revision,
        this.customInstructionEditor.revision,
        this.customInstructionEditor.draft,
        String(unavailable.message ?? "レビューを開始できませんでした。")
      )) {
        this.renderCustomInstructionState();
      }
      return;
    }

    if (message.type === "customInstructionReviewCompleted") {
      const completed = message as CustomInstructionReviewResultMessage;
      if (this.customInstructionReview.complete(
        completed.revision,
        this.customInstructionEditor.revision,
        this.customInstructionEditor.draft,
        completed.result
      )) {
        this.renderCustomInstructionState();
      }
      return;
    }

    if (message.type === "customInstructionReviewFailed") {
      const failed = message as CustomInstructionReviewStatusMessage;
      if (this.customInstructionReview.fail(
        failed.revision,
        this.customInstructionEditor.revision,
        this.customInstructionEditor.draft,
        String(failed.message ?? "レビューに失敗しました。")
      )) {
        this.renderCustomInstructionState();
      }
      return;
    }

    if (message.type === "scanStarted") {
      this.workspaceScanPending = true;
      this.renderTimelineMessages();
      this.addSystemMessage("ワークスペースを検査中です。", "info");
      return;
    }

    if (message.type === "scanCompleted") {
      const completed = message as ScanCompletedMessage;
      this.workspaceScanPending = false;
      this.workspaceTrusted = completed.result.workspaceTrusted;
      this.addPreviewMessage(completed.result.contextPackage, completed.result.workspaceMap);
      this.addSystemMessage(`${completed.result.rootName} の検査が完了しました。マスク済み内容を確認してください。`, "success");
      this.renderComposerState();
      return;
    }

    if (message.type === "scanFailed") {
      this.workspaceScanPending = false;
      this.addSystemMessage(String(message.message ?? "検査に失敗しました。"), "danger");
      this.pendingApproval = undefined;
      this.renderComposerState();
      return;
    }

    if (message.type === "workspaceReferences") {
      const references = message as WorkspaceReferencesMessage;
      if (!this.referenceQueryRange || references.query !== this.referenceQueryRange.query) {
        return;
      }
      this.referenceSuggestions = references.items.map((reference) => ({
        label: reference.path,
        insertText: `@${reference.path}`,
        icon: reference.kind === "directory" ? "folderSimple" : "file",
        reference
      }));
      this.selectedReferenceSuggestionIndex = 0;
      this.renderReferenceSuggestions();
      return;
    }

    if (message.type === "serverHealth") {
      if (this.isCurrentServerCheckResponse(message)) {
        this.serverCheckStatus = "success";
        this.serverCheckRequestId = undefined;
        this.renderActivePopover();
        return;
      }
      this.addSystemMessage(`App Server接続成功: ${JSON.stringify(message.health)}`, "success");
      return;
    }

    if (message.type === "serverTokenValidation") {
      this.applyServerTokenValidation(message as ServerTokenValidationMessage);
      return;
    }

    if (message.type === "serverTokenMissing") {
      this.applyServerTokenMissing(message as ServerTokenMissingMessage);
      return;
    }

    if (message.type === "serverMentorCompleted") {
      const completed = message as ServerMentorCompletedMessage;
      this.finishServerRequest();
      this.addAssistantMessage(
        completed.result.response,
        completed.result.assistantMessageId,
        this.normalizeHintLevel(completed.result.hintLevel),
        completed.result.conversationId
      );
      this.addSystemMessage(completed.result.safety, "success");
      if (completed.result.securityFeedback) {
        this.addSecurityFeedbackMessage(completed.result.securityFeedback);
      }
      return;
    }

    if (message.type === "serverMentorProgress") {
      const progress = message as ServerMentorProgressMessage;
      if (progress.factual) {
        this.clearServerProgressTimers();
      }
      this.updateServerProgress(progress.message);
      return;
    }

    if (message.type === "serverFailed") {
      if (this.isCurrentServerCheckResponse(message)) {
        this.serverCheckStatus = "failed";
        this.serverCheckRequestId = undefined;
        this.renderActivePopover();
        return;
      }
      const failureSource = this.serverMentorPendingSource;
      this.finishServerRequest();
      this.addSystemMessage(this.serverFailureMessage(failureSource, message.message), "danger");
      return;
    }

    if (message.type === "patchToolCallApplied") {
      const applied = message as PatchToolCallAppliedMessage;
      if (applied.messageId) {
        this.clearAssistantActionPending(applied.messageId, "applyPatch");
        this.markAssistantActionApprovedById(applied.messageId, "applyPatch");
      }
      this.addSystemMessage(
        this.systemMessageTextWithFileFallback(applied.result.message, applied.result.files),
        "success",
        { linkedFiles: applied.result.files }
      );
      if (applied.messageId) {
        this.continueAfterEditApplied(applied.messageId, applied.result);
      }
      return;
    }

    if (message.type === "patchToolCallFailed") {
      const failed = message as PatchToolCallFailedMessage;
      if (failed.messageId) {
        this.clearAssistantActionPending(failed.messageId, "applyPatch");
      }
      const failureMessage = String(failed.message ?? "編集案の適用に失敗しました。");
      this.addSystemMessage(failureMessage, "danger");
      if (failed.messageId) {
        this.retryAfterPatchApplyFailed(failed.messageId, failureMessage, failed.result);
      }
      return;
    }

    if (message.type === "commandExecutionCompleted") {
      const completed = message as CommandExecutionCompletedMessage;
      this.commandExecutionPending = false;
      this.handleCommandExecutionCompleted(completed.result, completed.messageId);
      return;
    }

    if (message.type === "commandExecutionOutput") {
      const output = message as CommandExecutionOutputMessage;
      this.updateCommandExecutionLog(output.snapshot, output.messageId);
      return;
    }

    if (message.type === "commandExecutionFailed") {
      const failed = message as CommandExecutionFailedMessage;
      this.commandExecutionPending = false;
      this.failCommandExecutionLog(failed.messageId, String(failed.message ?? "コマンド実行に失敗しました。"));
      this.addSystemMessage(String(failed.message ?? "コマンド実行に失敗しました。"), "danger");
      return;
    }

    if (message.type === "mcpToolExecutionCompleted") {
      const completed = message as McpToolExecutionCompletedMessage;
      if (completed.messageId) {
        this.clearAssistantActionPending(completed.messageId, "mcpTool");
        this.markAssistantActionApprovedById(completed.messageId, "mcpTool");
      }
      this.handleMcpToolExecutionCompleted(completed.result);
      return;
    }

    if (message.type === "mcpToolExecutionFailed") {
      const failed = message as McpToolExecutionFailedMessage;
      if (failed.messageId) {
        this.clearAssistantActionPending(failed.messageId, "mcpTool");
      }
      this.addSystemMessage(
        String(failed.message ?? "MCP Tool実行に失敗しました。"),
        "danger",
        { scrollToBottom: true }
      );
      return;
    }

    if (message.type === "workspaceFileOpenFailed") {
      this.addSystemMessage(String(message.message ?? "ファイルを開けませんでした。"), "warning");
      return;
    }

    if (message.type === "conversationPersistenceFailed") {
      this.addSystemMessage(`会話履歴を保存できませんでした。${String(message.message ?? "")}`, "warning");
    }
  }

  private async submitComposer(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.serverMentorPending) {
      return;
    }

    if (!this.workspaceTrusted) {
      this.addSystemMessage("未信頼ワークスペースでは送信できません。", "danger");
      return;
    }

    this.syncSelectedReferencesFromInput();
    const references = [...this.selectedReferences];
    const request = this.createMentorRequest(text);
    const startNewConversation = this.viewMode !== "conversation" && this.messages.length > 0;
    if (this.viewMode !== "conversation") {
      if (startNewConversation) {
        this.messages.splice(0, this.messages.length);
        this.currentConversationId = undefined;
      }
      this.currentConversationTitle = "新しいチャット";
      this.viewMode = "conversation";
      this.activePopover = undefined;
      this.renderShell();
    }
    const userMessageId = this.addUserMessage(text, references, this.workspaceInspectionSelected);
    if (!this.bridge.isVsCode) {
      this.recordRecentTask(text);
    }
    this.input.value = "";
    this.selectedReferences = [];
    this.clearReferenceSuggestions();

    if (this.workspaceInspectionSelected) {
      this.pendingApproval = {
        request,
        references,
        userMessageId,
        workspaceInspection: true,
        startNewConversation
      };
      this.workspaceInspectionSelected = false;
      this.workspaceScanPending = true;
      this.addSystemMessage("ワークスペース検査を実行します。機械チェックとAIによるセキュリティ確認の結果を送信前プレビューに表示します。", "info");
      this.bridge.post({ type: "scanWorkspace" });
      this.renderComposerState();
      return;
    }

    this.sendMentorRequest(request, references, undefined, userMessageId, false, startNewConversation);
  }

  private isCurrentServerCheckResponse(message: WebviewBridgeMessage): boolean {
    return typeof message.requestId === "string" && message.requestId === this.serverCheckRequestId;
  }

  private applyServerTokenValidation(message: ServerTokenValidationMessage): void {
    if (
      this.serverTokenValidationRequestId &&
      typeof message.requestId === "string" &&
      message.requestId !== this.serverTokenValidationRequestId
    ) {
      return;
    }

    if (typeof message.requestId === "string") {
      this.serverTokenValidationRequestId = undefined;
    }
    this.serverTokenStatus = this.normalizeServerTokenStatus(message.status);
    this.renderActivePopover();
  }

  private applyServerTokenMissing(message: ServerTokenMissingMessage): void {
    void message;
    this.serverTokenConfigured = false;
    this.serverTokenStatus = "missing";
    this.activePopover = "settings";
    this.renderActivePopover();
  }

  private normalizeServerTokenStatus(status: unknown): ServerTokenUiStatus {
    if (status === "valid" || status === "invalid" || status === "failed" || status === "missing") {
      return status;
    }

    return "failed";
  }

  private sendMentorRequest(
    request: MentorRequest,
    references: readonly WorkspaceReference[],
    contextPackage: ContextPackage | undefined,
    userMessageId: string,
    workspaceInspection: boolean,
    startNewConversation: boolean,
    source: ServerMentorPendingSource = "user",
    commandResult?: CommandExecutionResult,
    continuation?: MentorContinuation,
    editResult?: EditApplicationResult
  ): void {
    if (!this.bridge.isVsCode) {
      this.addSystemMessage("ブラウザ単体プレビューでは VS Code SecretStorage を使えないため、App Server 送信は無効です。", "warning");
      return;
    }

    this.serverMentorPending = true;
    this.serverMentorPendingSource = source;
    this.serverMentorProgressLabel = this.serverStartMessage(source);
    this.addSystemMessage(this.serverMentorProgressLabel, "info");
    this.startServerProgressTimers(source);
    this.renderComposerState();
    this.bridge.post({
      type: "mentorViaServer",
      approved: true,
      request,
      references,
      ...(startNewConversation ? {} : { conversationId: this.currentConversationId }),
      clientMessageId: userMessageId,
      workspaceInspection,
      startNewConversation,
      ...(contextPackage ? { contextPackage } : {}),
      ...(commandResult ? { commandResult } : {}),
      ...(editResult ? { editResult } : {}),
      ...(continuation ? { continuation } : {})
    });
  }

  private approvePreview(contextPackage: ContextPackage): void {
    if (!this.pendingApproval) {
      this.addSystemMessage("承認対象のチャットリクエストがありません。", "warning");
      return;
    }

    const pending = this.pendingApproval;
    this.pendingApproval = undefined;
    this.sendMentorRequest(
      pending.request,
      pending.references,
      contextPackage,
      pending.userMessageId,
      pending.workspaceInspection,
      pending.startNewConversation
    );
  }

  private createMentorRequest(task: string): MentorRequest {
    return {
      task,
      hintLevel: this.hintLevel
    };
  }

  private handleReferenceQuery(): void {
    const cursor = this.input.selectionStart;
    const beforeCursor = this.input.value.slice(0, cursor);
    const dollarIndex = beforeCursor.lastIndexOf("$");
    if (dollarIndex >= 0 && (dollarIndex === 0 || /\s/.test(beforeCursor.charAt(dollarIndex - 1)))) {
      const query = beforeCursor.slice(dollarIndex + 1);
      if (!/\s/.test(query)) {
        this.referenceQueryRange = { start: dollarIndex, end: cursor, query: `$${query}` };
        const skills: ComposerSuggestion[] = this.capabilities.skills
          .filter((skill) => skill.name.toLowerCase().includes(query.toLowerCase()))
          .map((skill) => ({ label: `$${skill.name}`, insertText: `$${skill.name}`, icon: "plus" }));
        const servers: ComposerSuggestion[] = this.capabilities.mcpServers
          .filter((server) => server.approved && server.id.toLowerCase().includes(query.toLowerCase()))
          .map((server) => ({ label: `$mcp:${server.id}`, insertText: `$mcp:${server.id}`, icon: "plus" }));
        this.referenceSuggestions = [...skills, ...servers].slice(0, 8);
        this.selectedReferenceSuggestionIndex = 0;
        this.renderReferenceSuggestions();
        if (this.capabilities.skills.length === 0 && this.capabilities.mcpServers.length === 0) this.bridge.post({ type: "loadCapabilities" });
        return;
      }
    }
    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex < 0 || (atIndex > 0 && !/\s/.test(beforeCursor.charAt(atIndex - 1)))) {
      this.clearReferenceSuggestions();
      return;
    }

    const query = beforeCursor.slice(atIndex + 1);
    if (/\s/.test(query)) {
      this.clearReferenceSuggestions();
      return;
    }

    this.referenceQueryRange = {
      start: atIndex,
      end: cursor,
      query
    };
    this.bridge.post({
      type: "listWorkspaceReferences",
      query
    });
  }

  private selectReference(suggestion: ComposerSuggestion): void {
    if (!this.referenceQueryRange) {
      return;
    }

    const value = this.input.value;
    this.input.value = `${value.slice(0, this.referenceQueryRange.start)}${suggestion.insertText} ${value.slice(this.referenceQueryRange.end)}`;
    this.input.focus();
    if (suggestion.reference) {
      this.selectedReferences = [
        ...this.selectedReferences.filter((item) => item.path !== suggestion.reference?.path),
        suggestion.reference
      ];
    }
    this.clearReferenceSuggestions();
    this.renderComposerState();
  }

  private renderRecentTaskItems(): void {
    if (!this.recentSlot) {
      return;
    }

    this.factory.clear(this.recentSlot);
    if (this.recentTasks.length === 0) {
      this.recentSlot.append(this.factory.element("button", "recent-task muted-task", "直近のタスクはありません"));
      return;
    }

    for (const task of this.recentTasks.slice(0, 3)) {
      this.recentSlot.append(this.renderTaskButton(task, "recent-task"));
    }

    const showAll = this.factory.button(`すべて表示（合計${this.recentTasks.length}件）`, "recent-show-all");
    showAll.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activePopover = "history";
      this.renderActivePopover();
    });
    this.recentSlot.append(showAll);
  }

  private renderTaskButton(task: PersistedConversationSummary, className: string): HTMLButtonElement {
    const item = this.factory.button("", className, task.title);
    item.append(
      this.factory.element("span", "task-title", task.title),
      this.factory.element("span", "task-time", this.relativeTime(task.updatedAt))
    );
    item.addEventListener("click", () => this.openConversation(task.conversationId));
    return item;
  }

  private renderTimelineMessages(): void {
    if (!this.timelineSlot) {
      return;
    }

    const wasNearBottom = this.isTimelineNearBottom(this.timelineSlot);
    const previousScrollTop = this.timelineSlot.scrollTop;
    const entries = this.timelineEntries();
    const stateSignature = this.timelineStateKey();
    const stateChanged = stateSignature !== this.timelineStateSignature;
    this.timelineStateSignature = stateSignature;
    const desiredKeys = new Set(entries.map((entry) => entry.key));

    for (const [key, element] of this.timelineElements) {
      if (!desiredKeys.has(key)) {
        element.remove();
        this.timelineElements.delete(key);
      }
    }

    if (entries.length === 0) {
      const key = "empty";
      let empty = this.timelineElements.get(key);
      if (!empty) {
        empty = this.renderEmptyTimeline();
        this.timelineElements.set(key, empty);
      }
      this.timelineSlot.append(empty);
      this.restoreTimelineScroll(previousScrollTop, wasNearBottom);
      return;
    }

    const empty = this.timelineElements.get("empty");
    if (empty) {
      empty.remove();
      this.timelineElements.delete("empty");
    }

    for (const entry of entries) {
      const existing = this.timelineElements.get(entry.key);
      const dirty = stateChanged || this.dirtyTimelineKeys.has(entry.key);
      let element = existing;
      if (!element || dirty) {
        element = entry.kind === "message"
          ? this.renderMessage(entry.message)
          : this.renderPendingLoader(entry.label);
        element.dataset.timelineKey = entry.key;
        if (!existing) {
          element.classList.add("message-enter");
        }
        if (existing) {
          existing.replaceWith(element);
        }
        this.timelineElements.set(entry.key, element);
      }
      this.timelineSlot.append(element);
    }

    this.dirtyTimelineKeys.clear();
    this.restoreTimelineScroll(previousScrollTop, wasNearBottom);
  }

  private timelineEntries(): readonly (
    | { readonly key: string; readonly kind: "message"; readonly message: ChatMessage }
    | { readonly key: string; readonly kind: "loader"; readonly label: string }
  )[] {
    const entries: (
      | { readonly key: string; readonly kind: "message"; readonly message: ChatMessage }
      | { readonly key: string; readonly kind: "loader"; readonly label: string }
    )[] = this.messages.map((message) => ({
      key: `message:${message.id}`,
      kind: "message",
      message
    }));
    const pendingLabel = this.pendingLoaderLabel();
    if (pendingLabel) {
      entries.push({
        key: "pending-loader",
        kind: "loader",
        label: pendingLabel
      });
    }
    return entries;
  }

  private renderEmptyTimeline(): HTMLElement {
    const empty = this.factory.element("div", "empty-state");
    empty.append(
      this.renderLogoMark(),
      this.factory.element("div", "empty-text", "チャットを開始してください")
    );
    return empty;
  }

  private renderPendingLoader(label: string): HTMLElement {
    const row = this.factory.element("article", "message message-system pending-message");
    const body = this.factory.element("div", "pending-loader");
    body.append(
      this.factory.element("span", "pending-loader-dot"),
      this.factory.element("span", "pending-loader-dot"),
      this.factory.element("span", "pending-loader-dot"),
      this.factory.element("span", "pending-loader-label", label)
    );
    row.append(body);
    return row;
  }

  private pendingLoaderLabel(): string | undefined {
    if (this.serverMentorPending) {
      return this.serverMentorProgressLabel ?? this.defaultServerPendingLabel(this.serverMentorPendingSource);
    }
    if (this.workspaceScanPending) {
      return "ワークスペース検査中です";
    }
    if (this.commandExecutionPending) {
      return "コマンド実行中です";
    }
    return undefined;
  }

  private timelineStateKey(): string {
    return [
      this.workspaceTrusted ? "trusted" : "untrusted",
      this.serverMentorPending ? "server-pending" : "server-idle",
      this.workspaceScanPending ? "scan-pending" : "scan-idle",
      this.commandExecutionPending ? "command-pending" : "command-idle",
      this.pendingApproval ? "has-preview-approval" : "no-preview-approval"
    ].join("|");
  }

  private isTimelineNearBottom(timeline: HTMLElement): boolean {
    return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 24;
  }

  private restoreTimelineScroll(previousScrollTop: number, wasNearBottom: boolean): void {
    if (!this.timelineSlot) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (!this.timelineSlot) {
        return;
      }
      if (wasNearBottom) {
        this.timelineSlot.scrollTop = this.timelineSlot.scrollHeight;
        return;
      }
      this.timelineSlot.scrollTop = previousScrollTop;
    });
  }

  private renderMessage(message: ChatMessage): HTMLElement {
    const row = this.factory.element("article", `message message-${message.kind}`);
    if (message.kind === "user") {
      const body = this.factory.element("div", "message-bubble");
      body.append(this.linkedText.render("div", "message-text", message.text));
      if (message.references.length > 0 || message.workspaceInspection) {
        const chips = this.factory.element("div", "chip-row");
        for (const reference of message.references) {
          chips.append(this.factory.element("span", "context-chip", `@${reference.path}`));
        }
        if (message.workspaceInspection) {
          chips.append(this.factory.element("span", "context-chip", "ワークスペース検査"));
        }
        body.append(chips);
      }
      row.append(body);
      return row;
    }

    if (message.kind === "assistant") {
      const showImplementationActions = this.allowsImplementationActions(message.hintLevel);
      const patch = patchToolCall(message.response);
      const command = commandToolCall(message.response);
      const mcp = mcpToolCall(message.response);
      const body = this.factory.element("div", "message-bubble assistant-bubble");
      body.append(this.mentorView.render(message.response, { showImplementationActions }));
      body.append(this.renderAssistantActions(message));
      if ((patch || requiresManualImplementation(message.response)) && showImplementationActions) {
        const action: AssistantApprovalAction = "applyPatch";
        body.append(this.renderAssistantEditActionRow(message, action));
      }
      if (command && showImplementationActions) {
        body.append(this.commandView.render(this.cardFromCommandToolCall(command)));
        const action: AssistantApprovalAction = "runCommand";
        body.append(this.renderAssistantCommandActionRow(message, action));
        const executionLog = this.renderCommandExecutionLog(message.id);
        if (executionLog) {
          body.append(executionLog);
        }
      }
      if (mcp && showImplementationActions) {
        body.append(this.mcpToolView.render(mcp));
        body.append(this.renderAssistantMcpToolActionRow(message));
      }
      row.append(body);
      return row;
    }

    if (message.kind === "preview") {
      const body = this.factory.element("div", "message-bubble assistant-bubble");
      body.append(this.previewView.render(message.contextPackage, message.workspaceMap));
      const approvalKey = `preview:${message.id}`;
      const approveButton = this.factory.button("マスク済み内容を承認", "approval-button");
      approveButton.disabled = this.approvedActionKeys.has(approvalKey) || !this.pendingApproval || this.serverMentorPending;
      if (this.approvedActionKeys.has(approvalKey)) {
        approveButton.textContent = "マスク済み内容を承認済み";
      }
      approveButton.addEventListener("click", () => {
        if (this.approvedActionKeys.has(approvalKey)) {
          return;
        }
        if (!this.tryRunTimelineAction(approvalKey)) {
          return;
        }
        this.approvedActionKeys.add(approvalKey);
        this.dirtyTimelineKeys.add(`message:${message.id}`);
        this.renderTimelineMessages();
        this.approvePreview(message.contextPackage);
      });
      body.append(approveButton);
      row.append(body);
      return row;
    }

    if (message.kind === "securityFeedback") {
      const card = this.factory.element("section", "security-feedback-card");
      card.append(
        this.factory.element("div", "security-feedback-label", "AIによるセキュリティフィードバック"),
        this.linkedText.render("div", "security-feedback-body", message.text)
      );
      row.append(card);
      return row;
    }

    const systemBody = this.factory.element("div", `system-message system-${message.tone}`);
    systemBody.append(this.linkedText.renderInline(message.text));
    if (message.linkedFiles && message.linkedFiles.length > 0) {
      systemBody.append(this.renderSystemFileLinks(message.linkedFiles));
    }
    row.append(systemBody);
    return row;
  }

  private renderSystemFileLinks(paths: readonly string[]): HTMLElement {
    const row = this.factory.element("div", "system-file-links");
    row.append(this.factory.element("span", "system-file-links-label", "対象: "));
    paths.forEach((path, index) => {
      if (index > 0) {
        row.append(document.createTextNode(", "));
      }
      row.append(this.linkedText.renderInline(path));
    });
    return row;
  }

  private systemMessageTextWithFileFallback(message: string, files: readonly string[]): string {
    return files.length > 0 ? message : `${message} 対象: 対象ファイルなし`;
  }

  private renderAssistantEditActionRow(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): HTMLElement {
    const patch = patchToolCall(message.response);
    const manualImplementation = requiresManualImplementation(message.response);
    const approved = this.isAssistantActionApproved(message, action);
    const pending = this.isAssistantActionPending(message, action);
    const actionKey = this.approvalKey(message.id, action);
    const buttons: HTMLButtonElement[] = [];
    if (patch && !manualImplementation) {
      const applyButton = this.factory.button("編集案を適用", "approval-button");
      applyButton.disabled = approved || pending || !this.workspaceTrusted || this.serverMentorPending;
      if (approved) {
        applyButton.textContent = "編集案を適用済み";
      } else if (pending) {
        applyButton.textContent = "編集案を適用中";
      }
      applyButton.addEventListener("click", () => {
        if (
          !patch ||
          this.isAssistantActionApproved(message, action) ||
          this.isAssistantActionPending(message, action)
        ) {
          return;
        }
        if (!this.tryRunTimelineAction(actionKey)) {
          return;
        }
        this.markAssistantActionPending(message, action);
        this.bridge.post({
          type: "applyPatchToolCall",
          ...(this.currentConversationId ? { conversationId: this.currentConversationId } : {}),
          messageId: message.id,
          toolCall: patch
        });
      });
      buttons.push(applyButton);
    }

    const manualKey = this.manualImplementationKey(message.id);
    if (this.manualImplementationKeys.has(manualKey)) {
      const reviewButton = this.factory.button("実装内容をレビュー", "approval-button approval-button-review");
      reviewButton.disabled = !this.workspaceTrusted || this.serverMentorPending;
      reviewButton.addEventListener("click", () => this.requestManualImplementationReview(message));
      buttons.push(reviewButton);
    } else if (!approved && !pending) {
      const completeButton = this.factory.button("実装完了", "approval-button approval-button-secondary");
      completeButton.disabled = !this.workspaceTrusted || this.serverMentorPending;
      completeButton.addEventListener("click", () => {
        if (
          (!patch && !manualImplementation) ||
          this.isAssistantActionApproved(message, action) ||
          this.isAssistantActionPending(message, action)
        ) {
          return;
        }
        if (!this.tryRunTimelineAction(actionKey)) {
          return;
        }
        this.completeImplementationManually(message);
      });
      buttons.push(completeButton);
    }

    return this.renderApprovalButtonRow(...buttons);
  }

  private renderAssistantCommandActionRow(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): HTMLElement {
    const command = commandToolCall(message.response);
    const approved = this.isAssistantActionApproved(message, action);
    const actionKey = this.approvalKey(message.id, action);
    const commandButton = this.factory.button("コマンド実行を承認", "approval-button");
    commandButton.disabled = approved || !this.workspaceTrusted || this.serverMentorPending || this.commandExecutionPending;
    if (approved) {
      commandButton.textContent = "コマンド実行を承認済み";
    }
    commandButton.addEventListener("click", () => {
      if (!command || this.isAssistantActionApproved(message, action)) {
        return;
      }
      if (!this.tryRunTimelineAction(actionKey)) {
        return;
      }
      this.markAssistantActionApproved(message, action);
      this.executeCommandToolCall(command, message.id);
    });

    if (approved) {
      return this.renderApprovalButtonRow(commandButton);
    }

    const manualButton = this.factory.button("コマンド実行完了", "approval-button approval-button-secondary");
    manualButton.disabled = !this.workspaceTrusted || this.serverMentorPending || this.commandExecutionPending;
    manualButton.addEventListener("click", () => {
      if (!command || this.isAssistantActionApproved(message, action)) {
        return;
      }
      if (!this.tryRunTimelineAction(actionKey)) {
        return;
      }
      this.markAssistantActionApproved(message, action);
      this.handleCommandExecutionCompleted(this.manualCommandExecutionResult(command), message.id);
    });

    return this.renderApprovalButtonRow(commandButton, manualButton);
  }

  private renderAssistantMcpToolActionRow(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>
  ): HTMLElement {
    const action: AssistantApprovalAction = "mcpTool";
    const toolCall = mcpToolCall(message.response);
    const approved = this.isAssistantActionApproved(message, action);
    const pending = this.isAssistantActionPending(message, action);
    const actionKey = this.approvalKey(message.id, action);
    const button = this.factory.button("MCP Tool実行を承認", "approval-button");
    button.disabled = approved || pending || !this.workspaceTrusted || this.serverMentorPending;
    if (approved) {
      button.textContent = "MCP Tool実行を承認済み";
    } else if (pending) {
      button.textContent = "MCP Tool実行中";
    }
    button.addEventListener("click", () => {
      if (!toolCall || approved || pending || !this.tryRunTimelineAction(actionKey)) {
        return;
      }
      this.markAssistantActionPending(message, action);
      this.executeMcpToolCall(toolCall, message.id);
    });
    return this.renderApprovalButtonRow(button);
  }

  private renderApprovalButtonRow(...buttons: readonly HTMLButtonElement[]): HTMLElement {
    const row = this.factory.element("div", "approval-button-row");
    row.append(...buttons);
    return row;
  }

  private renderCommandExecutionLog(messageId: string): HTMLElement | undefined {
    const log = this.commandExecutionLogs.get(messageId);
    if (!log) {
      return undefined;
    }

    const container = this.factory.element("section", `command-execution-log command-execution-${log.status}`);
    const heading = this.factory.element("div", "command-execution-heading");
    heading.append(
      this.factory.element("span", "command-execution-title", this.commandExecutionStatusLabel(log)),
      this.factory.element("span", "command-execution-meta", `${log.shell} / ${log.workingDirectory}`)
    );
    container.append(heading);

    if (log.activeStream) {
      container.append(this.factory.element("div", "command-execution-meta", `更新: ${log.activeStream}`));
    }

    if (log.stdout.trim().length === 0 && log.stderr.trim().length === 0) {
      container.append(this.factory.element("div", "command-execution-empty", "出力を安全確認中です。"));
    } else {
      if (log.stdout.trim().length > 0) {
        container.append(this.renderCommandExecutionStream("stdout", log.stdout));
      }
      if (log.stderr.trim().length > 0) {
        container.append(this.renderCommandExecutionStream("stderr", log.stderr));
      }
    }

    if (log.safetyNotice) {
      container.append(this.factory.element("div", "command-execution-safety", log.safetyNotice));
    }
    if (log.errorMessage) {
      container.append(this.factory.element("div", "command-execution-error", log.errorMessage));
    }

    return container;
  }

  private renderCommandExecutionStream(label: "stdout" | "stderr", content: string): HTMLElement {
    const block = this.factory.element("section", "command-execution-stream");
    block.append(
      this.factory.element("div", "command-execution-stream-label", label),
      this.factory.element("pre", "command-execution-output", content)
    );
    return block;
  }

  private commandExecutionStatusLabel(log: CommandExecutionLogState): string {
    if (log.status === "completed") {
      return `コマンド実行完了: 終了コード ${log.exitCode ?? "不明"}`;
    }

    if (log.status === "failed") {
      return "コマンド実行失敗";
    }

    return log.truncated ? "コマンド実行中: 出力上限に到達" : "コマンド実行中";
  }

  private renderAssistantActions(message: Extract<ChatMessage, { readonly kind: "assistant" }>): HTMLElement {
    const actions = this.factory.element("div", "assistant-actions");
    const copyButton = this.iconButton("copySimple", "assistant-action-button", "応答をコピー");
    copyButton.addEventListener("click", () => this.copyAssistantResponse(message));
    const timestamp = this.factory.element("time", "assistant-timestamp", this.formatMessageTime(message.createdAt)) as HTMLTimeElement;
    timestamp.dateTime = message.createdAt;
    timestamp.title = this.formatFullDateTime(message.createdAt);
    actions.append(copyButton, timestamp);
    return actions;
  }

  private copyAssistantResponse(message: Extract<ChatMessage, { readonly kind: "assistant" }>): void {
    const text = this.responseTextForCopy(message);
    void this.copyText(text).catch((error: unknown) => {
      console.warn("[Mentor Code Webview] assistant response copy failed", error);
      this.addSystemMessage("応答をクリップボードへコピーできませんでした。", "warning");
    });
  }

  private readClipboardText(): Promise<string> {
    if (!this.bridge.isVsCode) {
      return navigator.clipboard?.readText() ?? Promise.resolve("");
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingClipboardReads.delete(requestId);
        resolve("");
      }, 2_000);
      this.pendingClipboardReads.set(requestId, { resolve, timeoutId });
      this.bridge.post({ type: "readClipboardText", requestId });
    });
  }

  private async copyText(text: string): Promise<void> {
    if (this.bridge.isVsCode) {
      this.bridge.post({
        type: "copyText",
        text
      });
      return;
    }

    if (!navigator.clipboard) {
      throw new Error("この環境ではクリップボードを利用できません。");
    }
    await navigator.clipboard.writeText(text);
  }

  private openWorkspaceFile(path: string): void {
    if (!this.bridge.isVsCode) {
      this.addSystemMessage("ブラウザ単体プレビューではファイルを開けません。", "warning");
      return;
    }

    this.bridge.post({
      type: "openWorkspaceFile",
      path
    });
  }

  private responseTextForCopy(message: Extract<ChatMessage, { readonly kind: "assistant" }>): string {
    const response = message.response;
    const showImplementationActions = this.allowsImplementationActions(message.hintLevel);
    const lines: string[] = [response.title];
    if (response.policyWarnings.length > 0) {
      lines.push("", response.policyWarnings.join(" "));
    }
    for (const section of response.sections) {
      lines.push("", section.heading);
      for (const item of section.items) {
        lines.push(`- ${item}`);
      }
    }
    const patch = patchToolCall(response);
    const command = commandToolCall(response);
    const mcp = mcpToolCall(response);
    if (patch && showImplementationActions) {
      const preview = patchToolCallToEditPreview(patch);
      lines.push("", "編集案", preview.intent);
      for (const operation of preview.operations) {
        lines.push(`- ${operation.type}: ${operation.path}`, `  ${operation.explanation}`);
      }
    }
    if (command && showImplementationActions) {
      lines.push(
        "",
        "コマンド案",
        `${command.shell}: ${command.command}`,
        `作業ディレクトリ: ${command.workingDirectory}`,
        command.meaning,
        command.expectedResult
      );
    }
    if (mcp && showImplementationActions) {
      lines.push(
        "",
        "MCP Tool案",
        `${mcp.serverId}:${mcp.toolName}`,
        mcp.intent,
        mcp.expectedResult,
        JSON.stringify(mcp.arguments, null, 2)
      );
    }
    return lines.join("\n").trim();
  }

  private isAssistantActionApproved(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): boolean {
    return message.approvedActions.includes(action) || this.approvedActionKeys.has(this.approvalKey(message.id, action));
  }

  private isAssistantActionPending(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): boolean {
    return this.pendingActionKeys.has(this.approvalKey(message.id, action));
  }

  private markAssistantActionPending(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): void {
    this.pendingActionKeys.add(this.approvalKey(message.id, action));
    this.dirtyTimelineKeys.add(`message:${message.id}`);
    this.renderTimelineMessages();
  }

  private clearAssistantActionPending(messageId: string, action: AssistantApprovalAction): void {
    this.pendingActionKeys.delete(this.approvalKey(messageId, action));
    this.scheduleCommandExecutionLogRefresh(messageId);
  }

  private markAssistantActionApproved(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    action: AssistantApprovalAction
  ): void {
    this.clearAssistantActionPending(message.id, action);
    this.approvedActionKeys.add(this.approvalKey(message.id, action));
    this.dirtyTimelineKeys.add(`message:${message.id}`);
    this.renderTimelineMessages();
    if (!this.bridge.isVsCode) {
      return;
    }

    const conversationId = message.conversationId ?? this.currentConversationId;
    this.bridge.post({
      type: "markConversationActionApproved",
      ...(conversationId ? { conversationId } : {}),
      messageId: message.id,
      action
    });
  }

  private markAssistantActionApprovedById(messageId: string, action: AssistantApprovalAction): void {
    const message = this.messages.find((item): item is Extract<ChatMessage, { readonly kind: "assistant" }> => (
      item.kind === "assistant" && item.id === messageId
    ));
    if (!message) {
      this.clearAssistantActionPending(messageId, action);
      return;
    }

    this.markAssistantActionApproved(message, action);
  }

  private approvalKey(messageId: string, action: AssistantApprovalAction): string {
    return `${messageId}:${action}`;
  }

  private manualImplementationKey(messageId: string): string {
    return `${messageId}:manualImplementation`;
  }

  private tryRunTimelineAction(actionKey: string): boolean {
    const firstAction = firstBlockingTimelineAction(this.timelineActionCandidates());
    if (!firstAction || firstAction.key === actionKey) {
      return true;
    }

    this.addSystemMessage(
      `先に「${firstAction.label}」を完了してください。タイムライン上の操作は古い順に処理します。`,
      "warning"
    );
    return false;
  }

  private timelineActionCandidates(): readonly TimelineActionCandidate[] {
    const candidates: TimelineActionCandidate[] = [];

    for (const message of this.messages) {
      if (message.kind === "preview") {
        const approvalKey = `preview:${message.id}`;
        if (!this.approvedActionKeys.has(approvalKey) && this.pendingApproval && !this.serverMentorPending) {
          candidates.push({
            key: approvalKey,
            label: "マスク済み内容を承認"
          });
        }
        continue;
      }

      if (message.kind === "assistant") {
        if (!this.allowsImplementationActions(message.hintLevel)) {
          continue;
        }

        const patch = patchToolCall(message.response);
        const command = commandToolCall(message.response);
        const mcp = mcpToolCall(message.response);
        const manualImplementation = requiresManualImplementation(message.response);
        if (
          (patch || manualImplementation) &&
          !this.isAssistantActionApproved(message, "applyPatch") &&
          this.workspaceTrusted &&
          !this.serverMentorPending
        ) {
          candidates.push({
            key: this.approvalKey(message.id, "applyPatch"),
            label: manualImplementation
              ? "実装完了"
              : this.isAssistantActionPending(message, "applyPatch")
                ? "編集案を適用中"
                : "編集案を適用 / 実装完了"
          });
        }

        if (
          command &&
          !this.isAssistantActionApproved(message, "runCommand") &&
          this.workspaceTrusted &&
          !this.serverMentorPending &&
          !this.commandExecutionPending
        ) {
          candidates.push({
            key: this.approvalKey(message.id, "runCommand"),
            label: "コマンド実行を承認 / コマンド実行完了"
          });
        }
        if (
          mcp &&
          !this.isAssistantActionApproved(message, "mcpTool") &&
          this.workspaceTrusted &&
          !this.serverMentorPending
        ) {
          candidates.push({
            key: this.approvalKey(message.id, "mcpTool"),
            label: this.isAssistantActionPending(message, "mcpTool")
              ? "MCP Tool実行中"
              : "MCP Tool実行を承認"
          });
        }
        continue;
      }

    }

    return candidates;
  }

  private renderComposerState(): void {
    this.syncSelectedReferencesFromInput();
    const hasText = this.input.value.trim().length > 0;
    this.sendButton.disabled = !hasText || this.serverMentorPending || !this.workspaceTrusted;
    this.input.placeholder = "何でもできます";
    this.workspaceOptionButton.classList.toggle("menu-item-active", this.workspaceInspectionSelected);
    this.renderHintMenuState();

    const parts: string[] = [];
    if (this.workspaceInspectionSelected) {
      parts.push("ワークスペース検査");
    }
    if (this.selectedReferences.length > 0) {
      parts.push(`@ ${this.selectedReferences.length}件`);
    }
    this.contextStatus.textContent = parts.length > 0 ? parts.join(" / ") : "ローカルで作業";
  }

  private renderReferenceSuggestions(): void {
    this.factory.clear(this.referenceSlot);
    this.referenceSlot.classList.toggle("reference-suggestions-visible", this.referenceSuggestions.length > 0);
    const visibleSuggestions = this.visibleReferenceSuggestions();
    this.selectedReferenceSuggestionIndex = this.clampReferenceSuggestionIndex(this.selectedReferenceSuggestionIndex, visibleSuggestions.length);
    const activeId = visibleSuggestions.length > 0
      ? this.referenceSuggestionId(this.selectedReferenceSuggestionIndex)
      : "";
    if (activeId) {
      this.input.setAttribute("aria-activedescendant", activeId);
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }

    visibleSuggestions.forEach((suggestion, index) => {
      const item = this.factory.button("", "reference-item", suggestion.label);
      const selected = index === this.selectedReferenceSuggestionIndex;
      item.id = this.referenceSuggestionId(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.classList.toggle("reference-item-selected", selected);
      item.append(
        this.renderIcon(suggestion.icon, "reference-item-icon", COMPACT_ICON_SIZE),
        this.factory.element("span", "reference-item-label", suggestion.label)
      );
      item.addEventListener("click", () => this.selectReference(suggestion));
      this.referenceSlot.append(item);
    });
  }

  private handleReferenceSuggestionKeyDown(event: KeyboardEvent): boolean {
    if (event.key === "Escape" && this.referenceSuggestions.length > 0) {
      event.preventDefault();
      this.clearReferenceSuggestions();
      return true;
    }

    const visibleSuggestions = this.visibleReferenceSuggestions();
    if (visibleSuggestions.length === 0) {
      return false;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
      event.preventDefault();
      const selectedReference = visibleSuggestions[this.selectedReferenceSuggestionIndex] ?? visibleSuggestions[0];
      if (selectedReference) {
        this.selectReference(selectedReference);
      }
      return true;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.moveReferenceSuggestionSelection(1);
      return true;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.moveReferenceSuggestionSelection(-1);
      return true;
    }

    return false;
  }

  private moveReferenceSuggestionSelection(direction: 1 | -1): void {
    const visibleCount = this.visibleReferenceSuggestions().length;
    this.selectedReferenceSuggestionIndex = this.clampReferenceSuggestionIndex(
      this.selectedReferenceSuggestionIndex + direction,
      visibleCount
    );
    this.renderReferenceSuggestions();
  }

  private visibleReferenceSuggestions(): readonly ComposerSuggestion[] {
    return this.referenceSuggestions.slice(0, 8);
  }

  private clearReferenceSuggestions(): void {
    this.referenceQueryRange = undefined;
    this.referenceSuggestions = [];
    this.selectedReferenceSuggestionIndex = 0;
    this.renderReferenceSuggestions();
  }

  private syncSelectedReferencesFromInput(): void {
    if (this.selectedReferences.length === 0) {
      return;
    }

    this.selectedReferences = [...filterMentionedReferences(this.selectedReferences, this.input.value)];
  }

  private completeImplementationManually(message: Extract<ChatMessage, { readonly kind: "assistant" }>): void {
    const patch = patchToolCall(message.response);
    const manualTargets = manualImplementationTargetPaths(message.response);
    if (!patch && !requiresManualImplementation(message.response)) {
      return;
    }

    this.manualImplementationKeys.add(this.manualImplementationKey(message.id));
    this.markAssistantActionApproved(message, "applyPatch");
    const result: PatchToolCallAppliedMessage["result"] = {
      files: patch ? patchToolCallTargetPaths(patch) : manualTargets,
      message: "ユーザーが自力で実装完了として記録しました。"
    };
    this.addSystemMessage(
      this.systemMessageTextWithFileFallback(result.message, result.files),
      "success",
      { linkedFiles: result.files }
    );
    this.continueAfterEditApplied(message.id, result);
  }

  private requestManualImplementationReview(message: Extract<ChatMessage, { readonly kind: "assistant" }>): void {
    const patch = patchToolCall(message.response);
    const manualTargets = manualImplementationTargetPaths(message.response);
    if (!patch && !requiresManualImplementation(message.response)) {
      return;
    }

    if (!this.workspaceTrusted) {
      this.addSystemMessage("未信頼ワークスペースでは実装内容レビューを無効化しています。", "danger");
      return;
    }

    if (this.serverMentorPending) {
      return;
    }

    const editResult = this.deferredEditResults.get(message.id)
      ?? this.editApplicationResultForMessage(message, {
        files: patch ? patchToolCallTargetPaths(patch) : manualTargets,
        message: "ユーザーが自力で実装完了として記録しました。"
      });
    const commandResult = this.assistantCommandResults.get(message.id);
    this.sendMentorRequest(
      {
        task: this.manualImplementationReviewTask(editResult, Boolean(commandResult)),
        hintLevel: message.hintLevel
      },
      editResult.appliedFiles.map((path) => ({
        path,
        kind: "file"
      })),
      undefined,
      this.nextId(),
      false,
      false,
      "editResult",
      commandResult,
      {
        kind: "editApplied",
        sourceAssistantMessageId: message.id
      },
      editResult
    );
  }

  private executeCommandToolCall(toolCall: MentorCommandToolCall, messageId?: string): void {
    if (!this.bridge.isVsCode) {
      this.addSystemMessage("ブラウザ単体プレビューではコマンド実行は無効です。", "warning");
      return;
    }

    this.commandExecutionPending = true;
    this.startCommandExecutionLog(toolCall, messageId);
    this.renderTimelineMessages();
    this.renderComposerState();
    this.bridge.post({
      type: "executeCommandToolCall",
      toolCall,
      ...(messageId ? { messageId } : {})
    });
  }

  private executeMcpToolCall(toolCall: MentorMcpToolCall, messageId?: string): void {
    if (!this.bridge.isVsCode) {
      this.addSystemMessage("ブラウザ単体プレビューではMCP Tool実行は無効です。", "warning");
      return;
    }
    this.bridge.post({
      type: "executeMcpToolCall",
      toolCall,
      ...(messageId ? { messageId } : {})
    });
  }

  private startCommandExecutionLog(proposal: MentorCommandToolCall, messageId?: string): void {
    if (!messageId) {
      return;
    }

    this.commandExecutionLogs.set(messageId, {
      status: "running",
      shell: proposal.shell,
      command: proposal.command,
      workingDirectory: proposal.workingDirectory,
      stdout: "",
      stderr: ""
    });
    this.dirtyTimelineKeys.add(`message:${messageId}`);
  }

  private updateCommandExecutionLog(snapshot: CommandExecutionOutputSnapshot, messageId?: string): void {
    if (!messageId) {
      return;
    }

    const previous = this.commandExecutionLogs.get(messageId);
    this.commandExecutionLogs.set(messageId, {
      status: previous?.status === "completed" ? "completed" : "running",
      shell: snapshot.shell,
      command: snapshot.command,
      workingDirectory: snapshot.workingDirectory,
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      safetyNotice: snapshot.safetyNotice,
      activeStream: snapshot.activeStream,
      truncated: snapshot.truncated,
      ...(previous && "exitCode" in previous ? { exitCode: previous.exitCode } : {}),
      ...(previous?.errorMessage ? { errorMessage: previous.errorMessage } : {})
    });
    this.scheduleCommandExecutionLogRefresh(messageId);
  }

  private scheduleCommandExecutionLogRefresh(messageId: string): void {
    this.pendingCommandLogRefreshIds.add(messageId);
    if (this.commandLogRefreshFrame !== undefined) {
      return;
    }

    this.commandLogRefreshFrame = window.requestAnimationFrame(() => {
      this.commandLogRefreshFrame = undefined;
      const messageIds = [...this.pendingCommandLogRefreshIds];
      this.pendingCommandLogRefreshIds.clear();
      for (const pendingMessageId of messageIds) {
        this.refreshCommandExecutionLog(pendingMessageId);
      }
    });
  }

  private refreshCommandExecutionLog(messageId: string): void {
    if (!this.timelineSlot) {
      return;
    }

    const messageElement = this.timelineElements.get(`message:${messageId}`);
    const existingLog = messageElement?.querySelector<HTMLElement>(".command-execution-log");
    const nextLog = this.renderCommandExecutionLog(messageId);
    if (!messageElement || !existingLog || !nextLog) {
      this.dirtyTimelineKeys.add(`message:${messageId}`);
      this.renderTimelineMessages();
      return;
    }

    const wasNearBottom = this.isTimelineNearBottom(this.timelineSlot);
    const previousScrollTop = this.timelineSlot.scrollTop;
    existingLog.replaceWith(nextLog);
    this.scrollCommandExecutionOutputsToBottom(nextLog);
    this.restoreTimelineScroll(previousScrollTop, wasNearBottom);
  }

  private scrollCommandExecutionOutputsToBottom(container: HTMLElement): void {
    for (const output of Array.from(container.querySelectorAll<HTMLElement>(".command-execution-output"))) {
      output.scrollTop = output.scrollHeight;
    }
  }

  private clearCommandExecutionLogs(): void {
    this.commandExecutionLogs.clear();
    this.pendingCommandLogRefreshIds.clear();
    if (this.commandLogRefreshFrame !== undefined) {
      window.cancelAnimationFrame(this.commandLogRefreshFrame);
      this.commandLogRefreshFrame = undefined;
    }
  }

  private completeCommandExecutionLog(result: CommandExecutionResult, messageId?: string): void {
    if (!messageId) {
      return;
    }

    this.commandExecutionLogs.set(messageId, {
      status: "completed",
      shell: result.shell,
      command: result.command,
      workingDirectory: result.workingDirectory,
      stdout: result.stdout,
      stderr: result.stderr,
      safetyNotice: result.safetyNotice,
      exitCode: result.exitCode
    });
    this.dirtyTimelineKeys.add(`message:${messageId}`);
  }

  private failCommandExecutionLog(messageId: string | undefined, errorMessage: string): void {
    if (!messageId) {
      return;
    }

    const previous = this.commandExecutionLogs.get(messageId);
    if (!previous) {
      return;
    }

    this.commandExecutionLogs.set(messageId, {
      ...previous,
      status: "failed",
      errorMessage
    });
    this.dirtyTimelineKeys.add(`message:${messageId}`);
  }

  private cardFromCommandToolCall(proposal: MentorCommandToolCall): CommandApprovalCard {
    return this.commandPolicy.createApprovalCard(proposal.command, proposal.workingDirectory, {
      shell: proposal.shell,
      meaning: proposal.meaning,
      expectedResult: proposal.expectedResult,
      allowedToExecute: true
    });
  }

  private handleCommandExecutionCompleted(result: CommandExecutionResult, messageId?: string): void {
    if (messageId) {
      this.assistantCommandResults.set(messageId, result);
    }
    this.completeCommandExecutionLog(result, messageId);

    const maskedCount = result.safetySummary.maskedFindings;
    this.addSystemMessage([
      `コマンド実行が完了しました。終了コード: ${result.exitCode ?? "不明"}`,
      result.safetyNotice,
      maskedCount > 0 ? `機械検出により ${maskedCount} 件をマスクしました。` : "機械検出でマスク対象はありませんでした。"
    ].join("\n"), result.exitCode === 0 ? "success" : "warning");

    const editResult = messageId ? this.deferredEditResults.get(messageId) : undefined;
    if (messageId && editResult) {
      this.deferredEditResults.delete(messageId);
    }

    this.sendMentorRequest(
      {
        task: this.commandResultTask(result),
        hintLevel: this.hintLevel
      },
      [],
      undefined,
      this.nextId(),
      false,
      false,
      "commandResult",
      result,
      {
        kind: "commandCompleted",
        ...(messageId ? { sourceAssistantMessageId: messageId } : {})
      },
      editResult
    );
  }

  private handleMcpToolExecutionCompleted(result: McpToolExecutionResult): void {
    const summary = [
      `MCP Tool実行が完了しました: ${result.serverId}:${result.toolName}`,
      result.safetyNotice,
      result.truncated ? "結果は上限サイズで切り詰められています。" : "",
      result.content.slice(0, 4_000)
    ].filter((item) => item.length > 0).join("\n");
    this.addSystemMessage(summary, result.isError ? "warning" : "success");

    this.sendMentorRequest(
      {
        task: [
          "承認済みMCP Toolの実行結果を受け取りました。",
          "これは新しいユーザー依頼ではなく、直前のmcp_toolに対するtool resultです。",
          "結果を根拠として元の依頼へ回答し、同じMCP Toolを再提案しないでください。",
          `serverId: ${result.serverId}`,
          `toolName: ${result.toolName}`,
          `isError: ${result.isError}`,
          result.safetyNotice,
          result.truncated ? "resultTruncated: true" : "resultTruncated: false",
          `result:\n${result.content}`
        ].join("\n"),
        hintLevel: this.hintLevel
      },
      [],
      undefined,
      this.nextId(),
      false,
      false,
      "mcpResult"
    );
  }

  private serverStartMessage(source: ServerMentorPendingSource): string {
    if (source === "editResult") {
      return "編集適用結果の送信準備中です。送信直前クイック検閲を実行しています。";
    }

    if (source === "commandResult") {
      return "コマンド実行結果の送信準備中です。送信直前クイック検閲を実行しています。";
    }

    if (source === "mcpResult") {
      return "MCP Tool実行結果の送信準備中です。送信直前クイック検閲を実行しています。";
    }

    if (source === "patchRetry") {
      return "編集案の適用失敗を確認しています。現在のファイル内容で再生成します。";
    }

    return "送信準備中です。送信直前クイック検閲を実行しています。";
  }

  private serverFailureMessage(source: ServerMentorPendingSource | undefined, fallback: unknown): string {
    if (source === "editResult") {
      return "編集案は適用されましたが、適用結果をLLMへ送信できませんでした。詳細はログを確認してください。";
    }

    if (source === "commandResult") {
      return "コマンド実行は完了しましたが、実行結果をLLMへ送信できませんでした。詳細はログを確認してください。";
    }

    if (source === "mcpResult") {
      return "MCP Tool実行は完了しましたが、実行結果をLLMへ送信できませんでした。詳細はログを確認してください。";
    }

    return String(fallback ?? "App Server request failed.");
  }

  private commandResultTask(result: CommandExecutionResult): string {
    return [
      "承認済みコマンドの実行結果を受け取りました。",
      "conversationContext.lastCommandResult を前回 run_command の実行結果として扱ってください。",
      "exitCode が 0 の場合は、ユーザーが追加依頼をしていない限り新しい編集案やコマンド案を出さず、検証完了として要点だけ返してください。",
      "exitCode が 0 以外または不明の場合のみ、失敗原因に対する最小限の修復案を1回だけ提示してください。",
      `shell: ${result.shell}`,
      `workingDirectory: ${result.workingDirectory}`,
      `command: ${result.command}`,
      `exitCode: ${result.exitCode ?? "unknown"}`,
      result.safetyNotice
    ].join("\n");
  }

  private continueAfterEditApplied(
    messageId: string,
    result: PatchToolCallAppliedMessage["result"]
  ): void {
    const message = this.messages.find((item): item is Extract<ChatMessage, { readonly kind: "assistant" }> => (
      item.kind === "assistant" && item.id === messageId
    ));
    if (!message) {
      return;
    }

    const editResult = this.editApplicationResultForMessage(message, result);
    this.continueAfterEditResult(message, editResult);
  }

  private retryAfterPatchApplyFailed(messageId: string, reason: string, result?: PatchToolCallResult): void {
    const message = this.messages.find((item): item is Extract<ChatMessage, { readonly kind: "assistant" }> => (
      item.kind === "assistant" && item.id === messageId
    ));
    if (!message || this.serverMentorPending || !this.workspaceTrusted) {
      return;
    }

    const patch = patchToolCall(message.response);
    if (!patch) {
      return;
    }

    const parsedTargetFiles = patchToolCallTargetPaths(patch);
    const targetFiles = parsedTargetFiles.length > 0 ? parsedTargetFiles : (result?.files ?? []);
    const retryKey = this.approvalKey(message.id, "applyPatch");
    if (!shouldRetryAfterPatchApplyFailed({
      hasPatchToolCall: true,
      targetFileCount: targetFiles.length,
      alreadyRetried: this.patchApplyRetryKeys.has(retryKey),
      serverMentorPending: this.serverMentorPending,
      workspaceTrusted: this.workspaceTrusted
    })) {
      return;
    }

    this.patchApplyRetryKeys.add(retryKey);
    const editResult = result ? this.editApplicationResultForMessage(message, result) : undefined;
    this.sendMentorRequest(
      {
        task: this.patchApplyFailureRetryTask(reason, targetFiles, editResult),
        hintLevel: message.hintLevel
      },
      targetFiles.map((path) => ({
        path,
        kind: "file"
      })),
      undefined,
      this.nextId(),
      false,
      false,
      "patchRetry",
      undefined,
      {
        kind: "patchApplyFailed",
        sourceAssistantMessageId: message.id
      },
      editResult
    );
  }

  private continueAfterEditResult(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    editResult: EditApplicationResult
  ): void {
    this.deferredEditResults.set(message.id, editResult);
    const key = this.approvalKey(message.id, "applyPatch");
    if (!shouldContinueAfterEditApplied({
      hintLevel: message.hintLevel,
      response: message.response,
      alreadyContinued: this.continuedActionKeys.has(key),
      serverMentorPending: this.serverMentorPending
    })) {
      return;
    }

    this.continuedActionKeys.add(key);
    this.deferredEditResults.delete(message.id);
    this.sendMentorRequest(
      {
        task: this.editResultTask(editResult),
        hintLevel: message.hintLevel
      },
      editResult.appliedFiles.map((path) => ({
        path,
        kind: "file"
      })),
      undefined,
      this.nextId(),
      false,
      false,
      "editResult",
      undefined,
      {
        kind: "editApplied",
        sourceAssistantMessageId: message.id
      },
      editResult
    );
  }

  private editApplicationResultForMessage(
    message: Extract<ChatMessage, { readonly kind: "assistant" }>,
    result: PatchToolCallResult
  ): EditApplicationResult {
    return {
      assistantMessageId: message.id,
      appliedFiles: result.files,
      operationCount: result.operationCount ?? (patchToolCall(message.response) ? 1 : Math.max(1, result.files.length)),
      message: result.message,
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {})
    };
  }

  private manualCommandExecutionResult(proposal: MentorCommandToolCall): CommandExecutionResult {
    return {
      shell: proposal.shell,
      command: proposal.command,
      workingDirectory: proposal.workingDirectory,
      exitCode: 0,
      stdout: "ユーザーがこのコマンドをローカルで実行完了として記録しました。",
      stderr: "",
      safetySummary: {
        scannedFiles: 0,
        includedFiles: 0,
        blockedFiles: 0,
        maskedFindings: 0,
        warningFindings: 0,
        criticalFindings: 0
      },
      safetyNotice: "ユーザーの手動完了申告です。stdout/stderr は取得していません。"
    };
  }

  private manualImplementationReviewTask(result: EditApplicationResult, hasCommandResult: boolean): string {
    return [
      "ユーザーが自力で完了した実装内容のレビュー依頼を受け取りました。",
      "conversationContext.lastEditResult を直前の apply_patch に対するユーザー手動実装結果として扱ってください。",
      hasCommandResult
        ? "conversationContext.lastCommandResult が含まれる場合は、その検証結果も踏まえて実装が当初意図を満たすか確認してください。"
        : "現在の files[] を見て、当初の apply_patch の意図と差分が一致しているか確認してください。",
      "未達成の差分が明確な場合だけ、最小限の追加 apply_patch または run_command を返してください。",
      "問題がなければ、レビュー結果と次に確認すべき点だけを返してください。",
      `operationCount: ${result.operationCount}`,
      `appliedFiles: ${result.appliedFiles.join(", ")}`,
      result.message
    ].join("\n");
  }

  private editResultTask(result: EditApplicationResult): string {
    return [
      "承認済み編集案の適用結果を受け取りました。",
      "conversationContext.lastEditResult を直前の apply_patch の適用結果として扱ってください。",
      "現在の files[] と会話コンテキストを見て、Codexのように次に必要な作業を判断してください。",
      "追加編集が必要なら apply_patch、検証や起動確認が必要なら run_command、十分なら提案なしの完了報告を返してください。",
      "同じ編集案の再提示は禁止です。",
      `operationCount: ${result.operationCount}`,
      `appliedFiles: ${result.appliedFiles.join(", ")}`,
      result.message,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
      result.exitCode !== undefined ? `exitCode: ${result.exitCode ?? "unknown"}` : ""
    ].join("\n");
  }

  private patchApplyFailureRetryTask(
    reason: string,
    targetFiles: readonly string[],
    result?: EditApplicationResult
  ): string {
    return [
      "承認済み apply_patch の適用に失敗しました。",
      "これは新しいユーザー依頼ではなく、直前の apply_patch tool result として扱ってください。",
      "現在の files[] を正として読み直し、同じ目的を満たす新しい apply_patch を生成してください。",
      "古い hunk を再利用せず、ファイル編集を run_command で代替しないでください。",
      "十分な差分を作れない場合だけ、理由を説明して toolCalls を返さないでください。",
      `対象ファイル: ${targetFiles.join(", ")}`,
      `失敗理由: ${reason}`,
      ...(result
        ? [
          `exitCode: ${result.exitCode ?? "unknown"}`,
          `operationCount: ${result.operationCount}`,
          `appliedFiles: ${result.appliedFiles.join(", ")}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : ""
        ]
        : [])
    ].join("\n");
  }

  private clampReferenceSuggestionIndex(index: number, length: number): number {
    if (length <= 0) {
      return 0;
    }

    return Math.min(length - 1, Math.max(0, index));
  }

  private referenceSuggestionId(index: number): string {
    return `reference-suggestion-${index}`;
  }

  private togglePlusMenu(): void {
    this.activePopover = undefined;
    this.renderActivePopover();
    this.hideHintMenu();
    this.plusMenu.classList.toggle("plus-menu-hidden");
  }

  private hidePlusMenu(): void {
    this.plusMenu.classList.add("plus-menu-hidden");
  }

  private toggleHintMenu(): void {
    this.activePopover = undefined;
    this.renderActivePopover();
    this.hidePlusMenu();
    this.hintMenu.classList.toggle("hint-menu-hidden");
  }

  private toggleHeaderPopover(popover: HeaderPopover): void {
    this.hidePlusMenu();
    this.hideHintMenu();
    this.activePopover = this.activePopover === popover ? undefined : popover;
    this.renderActivePopover();
  }

  private hideHintMenu(): void {
    this.hintMenu.classList.add("hint-menu-hidden");
  }

  private selectHintLevel(level: MentorHintLevel): void {
    this.hintLevel = level;
    this.hideHintMenu();
    this.renderComposerState();
    if (this.viewMode !== "conversation") {
      return;
    }

    this.bridge.post({
      type: "updateConversationSettings",
      conversationId: this.currentConversationId,
      hintLevel: this.hintLevel
    });
  }

  private renderHintMenuState(): void {
    this.factory.clear(this.hintMenuButton);
    this.hintMenuButton.append(
      this.factory.element("span", "hint-menu-current", this.hintLevelLabel()),
      this.renderIcon("caretDown", "hint-menu-chevron", COMPACT_ICON_SIZE)
    );

    for (const item of Array.from(this.hintMenu.querySelectorAll<HTMLButtonElement>("[data-hint-level]"))) {
      const active = item.dataset.hintLevel === this.hintLevel;
      item.classList.toggle("hint-menu-item-active", active);
      item.setAttribute("aria-checked", active ? "true" : "false");
      const check = item.querySelector(".hint-menu-check");
      if (check) {
        check.classList.toggle("hint-menu-check-visible", active);
      }
    }
  }

  private hintLevelLabel(): string {
    return HINT_LEVEL_OPTIONS.find((option) => option.value === this.hintLevel)?.label ?? "低";
  }

  private allowsImplementationActions(level: MentorHintLevel): boolean {
    return level === "high" || level === "very_high";
  }

  private normalizeHintLevel(value: MentorHintLevel | number | undefined): MentorHintLevel {
    if (typeof value === "number") {
      if (value >= 5) {
        return "very_high";
      }
      if (value >= 4) {
        return "high";
      }
      if (value >= 2) {
        return "medium";
      }
      return "low";
    }

    return value ?? this.hintLevel;
  }

  private handleDocumentClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
      this.hidePlusMenu();
      this.hideHintMenu();
      return;
    }

    if (!target.closest(".composer-icon-button") && !target.closest(".plus-menu")) {
      this.hidePlusMenu();
    }
    if (!target.closest(".hint-menu-control")) {
      this.hideHintMenu();
    }
    if (!target.closest(".topbar-popover") && !target.closest(".topbar-actions")) {
      this.activePopover = undefined;
      this.renderActivePopover();
    }
  }

  private startComposerResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget;
    const startY = event.clientY;
    const startHeight = this.input.getBoundingClientRect().height;

    if (handle instanceof HTMLElement) {
      handle.setPointerCapture(event.pointerId);
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const nextHeight = this.clamp(startHeight + startY - moveEvent.clientY, 52, 220);
      this.composerInputHeight = nextHeight;
      this.input.style.height = `${nextHeight}px`;
    };

    const stopResize = (): void => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      if (handle instanceof HTMLElement && handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  private startNewChat(): void {
    this.messages.splice(0, this.messages.length);
    this.pendingApproval = undefined;
    this.clearCommandExecutionLogs();
    this.selectedReferences = [];
    this.clearReferenceSuggestions();
    this.workspaceInspectionSelected = false;
    this.input.value = "";
    this.viewMode = "conversation";
    this.currentConversationTitle = "新しいチャット";
    this.activePopover = undefined;
    this.openConversationOnNextState = true;
    this.bridge.post({ type: "createConversation" });
    this.renderShell();
  }

  private showTaskList(): void {
    this.viewMode = "taskList";
    this.activePopover = undefined;
    this.renderShell();
  }

  private openConversation(conversationId: string): void {
    this.openConversationOnNextState = true;
    this.activePopover = undefined;
    this.bridge.post({
      type: "loadConversation",
      conversationId
    });
    this.renderComposerState();
  }

  private addUserMessage(text: string, references: readonly WorkspaceReference[], workspaceInspection: boolean): string {
    const id = this.nextId();
    this.messages.push({
      id,
      kind: "user",
      createdAt: new Date().toISOString(),
      text,
      references,
      workspaceInspection
    });
    this.renderTimelineMessages();
    return id;
  }

  private addAssistantMessage(
    response: MentorResponse,
    id = this.nextId(),
    hintLevel: MentorHintLevel = this.hintLevel,
    conversationId = this.currentConversationId
  ): void {
    this.messages.push({
      id,
      kind: "assistant",
      createdAt: new Date().toISOString(),
      hintLevel,
      ...(conversationId ? { conversationId } : {}),
      response,
      approvedActions: []
    });
    this.renderTimelineMessages();
  }

  private addPreviewMessage(contextPackage: ContextPackage, workspaceMap: WorkspaceMap): void {
    this.messages.push({
      id: this.nextId(),
      kind: "preview",
      contextPackage,
      workspaceMap
    });
    this.renderTimelineMessages();
  }

  private addSystemMessage(
    text: string,
    tone: MessageTone,
    options: {
      readonly linkedFiles?: readonly string[];
      readonly scrollToBottom?: boolean;
    } = {}
  ): void {
    this.messages.push({
      id: this.nextId(),
      kind: "system",
      text,
      tone,
      ...(options.linkedFiles && options.linkedFiles.length > 0 ? { linkedFiles: options.linkedFiles } : {})
    });
    this.renderTimelineMessages();
    if (options.scrollToBottom) {
      this.keepTimelineAtBottomWhileRendering();
    }
  }

  private keepTimelineAtBottomWhileRendering(): void {
    const timeline = this.timelineSlot;
    if (!timeline) {
      return;
    }

    const scrollToBottom = (): void => {
      timeline.scrollTop = timeline.scrollHeight;
    };
    const observer = new MutationObserver(scrollToBottom);
    observer.observe(timeline, {
      childList: true,
      subtree: true,
      characterData: true
    });
    window.requestAnimationFrame(scrollToBottom);
    window.setTimeout(() => {
      observer.disconnect();
      scrollToBottom();
    }, 750);
  }

  private addSecurityFeedbackMessage(text: string): void {
    this.messages.push({
      id: this.nextId(),
      kind: "securityFeedback",
      text
    });
    this.renderTimelineMessages();
  }

  private recordRecentTask(task: string): void {
    if (!this.currentConversationId) {
      return;
    }

    const title = this.titleFromText(task);
    const now = new Date().toISOString();
    const summary: PersistedConversationSummary = {
      conversationId: this.currentConversationId,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: this.messages.length,
      lastMessagePreview: title
    };
    this.recentTasks = [
      summary,
      ...this.recentTasks.filter((item) => item.conversationId !== this.currentConversationId)
    ].slice(0, 5);
    this.renderRecentTaskItems();
  }

  private applyConversationState(message: ConversationStateMessage): void {
    this.currentConversationId = message.state.currentConversationId;
    this.recentTasks = [...message.state.conversations];
    this.hintLevel = message.state.current.hintLevel;
    this.currentConversationTitle = this.conversationTitleFor(message.state.currentConversationId);
    this.messages.splice(
      0,
      this.messages.length,
      ...message.state.current.messages.map((item) => this.toChatMessage(item, message.state.currentConversationId))
    );
    this.pendingApproval = undefined;
    this.pendingActionKeys.clear();
    this.clearCommandExecutionLogs();
    this.selectedReferences = [];
    this.clearReferenceSuggestions();
    this.workspaceInspectionSelected = false;
    this.input.value = "";
    if (this.openConversationOnNextState) {
      this.viewMode = "conversation";
      this.openConversationOnNextState = false;
    }
    this.renderShell();
  }

  private conversationTitleFor(conversationId: string): string {
    return this.recentTasks.find((task) => task.conversationId === conversationId)?.title ?? "新しいチャット";
  }

  private toChatMessage(message: PersistedConversationMessage, conversationId?: string): ChatMessage {
    if (message.kind === "user") {
      return {
        id: message.id,
        kind: "user",
        createdAt: message.createdAt,
        text: message.text,
        references: message.references,
        workspaceInspection: message.workspaceInspection
      };
    }

    return {
      id: message.id,
      kind: "assistant",
      createdAt: message.createdAt,
      hintLevel: this.normalizeHintLevel(message.hintLevel),
      ...(conversationId ? { conversationId } : {}),
      response: message.response,
      approvedActions: message.approvedActions ?? []
    };
  }

  private titleFromText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return "新しいチャット";
    }

    return normalized.length > 34 ? `${normalized.slice(0, 31)}...` : normalized;
  }

  private relativeTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return "";
    }

    const elapsedMs = Date.now() - timestamp;
    if (elapsedMs < 60_000) {
      return "今";
    }

    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) {
      return `${minutes}分`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}時間`;
    }

    return `${Math.floor(hours / 24)}日`;
  }

  private formatMessageTime(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return "";
    }

    return new Intl.DateTimeFormat("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  private formatFullDateTime(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return "";
    }

    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(date);
  }

  private startServerProgressTimers(source: ServerMentorPendingSource): void {
    this.clearServerProgressTimers();
    for (const milestone of this.serverProgressMilestones(source)) {
      const timer = window.setTimeout(() => {
        this.updateServerProgress(milestone.label);
      }, milestone.delayMs);
      this.serverProgressTimers.push(timer);
    }
  }

  private clearServerProgressTimers(): void {
    while (this.serverProgressTimers.length > 0) {
      const timer = this.serverProgressTimers.pop();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    }
  }

  private serverProgressMilestones(
    source: ServerMentorPendingSource
  ): readonly { readonly delayMs: number; readonly label: string }[] {
    return [
      {
        delayMs: 15_000,
        label: this.generatingProgressLabel(source)
      },
      {
        delayMs: 45_000,
        label: "アプリの応答に時間がかかっています。処理を継続しています。"
      },
      {
        delayMs: 90_000,
        label: "回答生成が続いています。完了までそのままお待ちください。"
      }
    ];
  }

  private updateServerProgress(label: string): void {
    if (!this.serverMentorPending) {
      return;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === this.serverMentorProgressLabel) {
      return;
    }

    this.serverMentorProgressLabel = trimmed;
    this.dirtyTimelineKeys.add("pending-loader");
    this.renderTimelineMessages();
  }

  private generatingProgressLabel(source: ServerMentorPendingSource): string {
    if (source === "editResult") {
      return "編集適用結果への回答を生成中です。";
    }

    if (source === "commandResult") {
      return "コマンド実行結果への回答を生成中です。";
    }

    if (source === "mcpResult") {
      return "MCP Tool実行結果への回答を生成中です。";
    }

    return "回答を生成中です。";
  }

  private defaultServerPendingLabel(source: ServerMentorPendingSource | undefined): string {
    if (source === "editResult") {
      return "編集適用結果へのLLM応答を待っています";
    }

    if (source === "commandResult") {
      return "コマンド実行結果へのLLM応答を待っています";
    }

    if (source === "mcpResult") {
      return "MCP Tool実行結果へのLLM応答を待っています";
    }

    return "LLMからの応答を待っています";
  }

  private finishServerRequest(): void {
    this.serverMentorPending = false;
    this.serverMentorPendingSource = undefined;
    this.serverMentorProgressLabel = undefined;
    this.clearServerProgressTimers();
    this.renderTimelineMessages();
    this.renderComposerState();
  }

  private nextId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("App root is missing.");
}

new MentorChatApplication().start(root);
