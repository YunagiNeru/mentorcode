import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CustomInstructionSafetyAudit,
  type CustomInstructionContext
} from "../domain/customInstructions";
import {
  CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
  type CustomInstructionReviewRequest
} from "../domain/customInstructionReview";
import type {
  CommandExecutionResult,
  ContextPackage,
  EditApplicationResult,
  FileGuardResult,
  LocalLlmReview,
  MentorCommandToolCall,
  MentorContinuation,
  MentorHintLevel,
  MentorMcpToolCall,
  MentorPatchToolCall,
  MentorRequest,
  MentorResponse
} from "../domain/types";
import {
  McpServerConfiguration,
  type McpServerDefinition,
  type McpToolContext
} from "../domain/mcp";
import { MentorActivityTracker, normalizeActivityHintLevel, type MentorActivityAction } from "../domain/mentorActivity";
import { SendTimeQuickAudit, type SendTimeQuickAuditDecision } from "../domain/privacy/sendTimeQuickAudit";
import {
  DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED,
  DEFAULT_ACTIVITY_BADGE_ENABLED,
  DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED,
  DEFAULT_SEND_SHORTCUT,
  normalizeBooleanPreference,
  normalizeSendShortcut,
  type AppSettings,
  type SendShortcut
} from "../domain/preferences";
import { BonsaiPrivacyGuardFactory } from "../localLlm/bonsaiPrivacyGuardFactory";
import { ConversationStore, type ConversationState, type PersistedConversationAction } from "./conversationStore";
import {
  APP_SERVER_TOKEN_MISSING_MESSAGE,
  AppClientVersionMismatchError,
  clientVersionFromPackageJson,
  MentorRequestError,
  ServerClient,
  type ServerTokenValidationResult
} from "./serverClient";
import { WindowsToastNotifier } from "./windowsToastNotifier";
import {
  CUSTOM_INSTRUCTION_MAX_BYTES,
  CustomInstructionStore,
  CustomInstructionStoreError
} from "./customInstructionStore";
import { WorkspaceCommandExecutor } from "./workspaceCommandExecutor";
import { WorkspacePatchApplier, WorkspacePatchApplyError } from "./workspacePatchApplier";
import { WorkspaceScanner, type WorkspaceReference } from "./workspaceScanner";
import { SkillSafetyAudit } from "../domain/skills/skillContext";
import type { SkillExecutionContext } from "../domain/skills/skillExecution";
import type { SkillRoot } from "../domain/skills/skillCatalog";
import { FileSystemSkillRepository } from "./skills/fileSystemSkillRepository";
import { SkillRegistry } from "./skills/skillRegistry";
import { McpClientManager } from "./mcp/mcpClientManager";
import { SkillManagementService } from "./skills/skillManagementService";
import {
  CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION,
  type CapabilityKind,
  type CapabilityReviewResult,
  type LocalCapabilityAudit
} from "../domain/capabilityReview";
import type { BonsaiCapabilityReviewer } from "../localLlm/bonsaiCapabilityReviewer";

type WebviewMessage =
  | { readonly type: "ready" }
  | { readonly type: "createConversation" }
  | { readonly type: "loadConversation"; readonly conversationId: string }
  | { readonly type: "updateConversationSettings"; readonly conversationId?: string; readonly hintLevel?: MentorHintLevel }
  | {
    readonly type: "updateAppSettings";
    readonly sendShortcut?: SendShortcut;
    readonly desktopNotificationsEnabled?: boolean;
    readonly activityBadgeEnabled?: boolean;
    readonly customInstructionsEnabled?: boolean;
  }
  | { readonly type: "scanWorkspace" }
  | { readonly type: "checkServer"; readonly requestId?: string }
  | { readonly type: "saveServerToken"; readonly token: string }
  | { readonly type: "validateServerToken"; readonly token?: string; readonly requestId?: string }
  | { readonly type: "openSettings" }
  | { readonly type: "openKeyboardShortcuts" }
  | { readonly type: "loadCustomInstruction" }
  | { readonly type: "saveCustomInstruction"; readonly content: string; readonly expectedRevision: string }
  | { readonly type: "openCustomInstructionLocation" }
  | { readonly type: "loadCapabilities" }
  | { readonly type: "installSkillFromGit" }
  | { readonly type: "installSkillFromLocal" }
  | { readonly type: "updateSkill"; readonly skillId: string }
  | { readonly type: "removeSkill"; readonly skillId: string }
  | { readonly type: "addMcpServer" }
  | { readonly type: "removeMcpServer"; readonly serverId: string }
  | { readonly type: "reviewCustomInstruction"; readonly revision: string }
  | { readonly type: "hideView" }
  | { readonly type: "maximizeView" }
  | { readonly type: "listWorkspaceReferences"; readonly query: string }
  | { readonly type: "openWorkspaceFile"; readonly path: string }
  | {
    readonly type: "applyPatchToolCall";
    readonly conversationId?: string;
    readonly messageId?: string;
    readonly toolCall: MentorPatchToolCall;
  }
  | { readonly type: "executeCommandToolCall"; readonly messageId?: string; readonly toolCall: MentorCommandToolCall }
  | { readonly type: "executeMcpToolCall"; readonly messageId?: string; readonly toolCall: MentorMcpToolCall }
  | {
    readonly type: "markConversationActionApproved";
    readonly conversationId?: string;
    readonly messageId: string;
    readonly action: PersistedConversationAction;
  }
  | { readonly type: "copyText"; readonly text: string }
  | { readonly type: "readClipboardText"; readonly requestId: string }
  | {
    readonly type: "mentorViaServer";
    readonly request: MentorRequest;
    readonly approved: boolean;
    readonly contextPackage?: ContextPackage;
    readonly references?: readonly WorkspaceReference[];
    readonly conversationId?: string;
    readonly startNewConversation?: boolean;
    readonly clientMessageId?: string;
    readonly workspaceInspection?: boolean;
    readonly commandResult?: CommandExecutionResult;
    readonly editResult?: EditApplicationResult;
    readonly continuation?: MentorContinuation;
  };

export class MentorWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "mentorCode.chat";

  private readonly scanner: WorkspaceScanner;
  private readonly sendTimeAudit: SendTimeQuickAudit;
  private readonly serverClient: ServerClient;
  private readonly conversations: ConversationStore;
  private readonly patchApplier: WorkspacePatchApplier;
  private readonly commandExecutor: WorkspaceCommandExecutor;
  private readonly activityTracker = new MentorActivityTracker();
  private readonly toastNotifier: WindowsToastNotifier;
  private readonly customInstructionSafetyAudit: CustomInstructionSafetyAudit;
  private readonly skillRegistry: SkillRegistry;
  private readonly skillRepository: FileSystemSkillRepository;
  private readonly skillManagement: SkillManagementService;
  private readonly capabilityReviewer: BonsaiCapabilityReviewer;
  private readonly mcpManager: McpClientManager;
  private readonly mcpServerConfiguration = new McpServerConfiguration();
  private readonly educationFeedbackStorageKey: string;
  private readonly reviewedTargetAuditKeys: Set<string>;
  private view: vscode.WebviewView | undefined;
  private serverTokenNoticeShown = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly customInstructionStore = new CustomInstructionStore()
  ) {
    const bonsaiFactory = new BonsaiPrivacyGuardFactory();
    const privacyGuard = bonsaiFactory.createForExtensionRoot(context.extensionUri.fsPath);
    this.customInstructionSafetyAudit = new CustomInstructionSafetyAudit(privacyGuard);
    this.skillRepository = new FileSystemSkillRepository(this.skillRoots());
    this.skillRegistry = new SkillRegistry(
      this.skillRepository,
      new SkillSafetyAudit(privacyGuard)
    );
    this.skillManagement = new SkillManagementService(join(context.globalStorageUri.fsPath, "skill-staging"), privacyGuard);
    this.capabilityReviewer = bonsaiFactory.createCapabilityReviewerForExtensionRoot(context.extensionUri.fsPath);
    this.mcpManager = new McpClientManager(
      context.secrets,
      () => this.approvedMcpServers(),
      clientVersionFromPackageJson(context.extension.packageJSON),
      privacyGuard,
      undefined,
      {
        redirectUrl: (serverId) => `${vscode.env.uriScheme}://${context.extension.id}/mcp-oauth/${encodeURIComponent(serverId)}`,
        openAuthorization: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url.toString())); }
      }
    );
    const projectReviewer = bonsaiFactory.createProjectReviewerForExtensionRoot(context.extensionUri.fsPath);
    this.scanner = new WorkspaceScanner(privacyGuard, projectReviewer);
    this.sendTimeAudit = new SendTimeQuickAudit(privacyGuard);
    this.serverClient = new ServerClient(context);
    this.patchApplier = new WorkspacePatchApplier();
    this.commandExecutor = new WorkspaceCommandExecutor(privacyGuard, {
      applyPatch: (patch, workingDirectory) => this.patchApplier.applyPatchText(patch, workingDirectory)
    });
    this.toastNotifier = new WindowsToastNotifier(context.extensionUri.fsPath);
    this.educationFeedbackStorageKey = `mentorCode.localLlmEducationFeedback.v1.${ConversationStore.workspaceKeyFromSource(this.workspaceKeySource())}`;
    this.reviewedTargetAuditKeys = new Set(context.globalState.get<readonly string[]>(this.educationFeedbackStorageKey, []));
    this.conversations = new ConversationStore(context.globalStorageUri.fsPath, {
      workspaceKey: ConversationStore.workspaceKeyFromSource(this.workspaceKeySource()),
      guard: privacyGuard
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.title = "Mentor Code";
    webviewView.description = "Chat";

    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        webviewRoot
      ]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    webviewView.onDidChangeVisibility(() => {
      void this.markVisibleActivityRead();
    });
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    void this.markVisibleActivityRead();
    this.updateActivityBadge();
  }

  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.mentorCode");
    try {
      await vscode.commands.executeCommand(`${MentorWebviewViewProvider.viewType}.focus`);
    } catch {
      this.view?.show(false);
    }
    await this.markVisibleActivityRead();
  }

  public async scanWorkspace(): Promise<void> {
    await this.post({
      type: "scanStarted"
    });

    try {
      const result = await this.scanner.scan();
      await this.post({
        type: "scanCompleted",
        result
      });
    } catch (error) {
      console.error("[Mentor Code Extension] workspace scan failed", error);
      await this.post({
        type: "scanFailed",
        message: this.genericFailureMessage()
      });
    }
  }

  public async markVisibleActivityRead(): Promise<void> {
    if (!this.isMentorViewReadable()) {
      this.updateActivityBadge();
      return;
    }

    this.activityTracker.markAllRead();
    this.updateActivityBadge();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      await this.post({
        type: "trustState",
        workspaceTrusted: vscode.workspace.isTrusted
      });
      await this.postAppSettings();
      await this.postConversationState(await this.conversations.initialState());
      await this.postCapabilityCatalog();
      await this.promptForMissingServerToken();
      await this.markVisibleActivityRead();
      return;
    }

    if (message.type === "createConversation") {
      await this.postConversationState(await this.conversations.createConversation());
      return;
    }

    if (message.type === "loadConversation") {
      await this.postConversationState(await this.conversations.loadConversation(message.conversationId));
      this.activityTracker.markConversationRead(message.conversationId);
      this.updateActivityBadge();
      return;
    }

    if (message.type === "updateConversationSettings") {
      await this.conversations.updateSettings({
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        ...(message.hintLevel ? { hintLevel: message.hintLevel } : {})
      });
      return;
    }

    if (message.type === "updateAppSettings") {
      await this.updateAppSettings(message);
      return;
    }

    if (message.type === "scanWorkspace") {
      await this.scanWorkspace();
      return;
    }

    if (message.type === "checkServer") {
      await this.checkServer(message.requestId);
      return;
    }

    if (message.type === "saveServerToken") {
      await this.saveServerToken(message.token);
      return;
    }

    if (message.type === "validateServerToken") {
      await this.validateServerToken(message.token, message.requestId);
      return;
    }

    if (message.type === "openSettings") {
      await this.openSettings();
      return;
    }

    if (message.type === "openKeyboardShortcuts") {
      await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings");
      return;
    }

    if (message.type === "loadCustomInstruction") {
      await this.loadCustomInstruction();
      return;
    }

    if (message.type === "saveCustomInstruction") {
      await this.saveCustomInstruction(message.content, message.expectedRevision);
      return;
    }

    if (message.type === "openCustomInstructionLocation") {
      await this.openCustomInstructionLocation();
      return;
    }

    if (message.type === "loadCapabilities") {
      await this.postCapabilityCatalog();
      return;
    }

    if (message.type === "installSkillFromGit") {
      await this.installSkillFromGit();
      return;
    }

    if (message.type === "installSkillFromLocal") {
      await this.installSkillFromLocal();
      return;
    }

    if (message.type === "updateSkill") {
      await this.updateSkill(message.skillId);
      return;
    }

    if (message.type === "removeSkill") {
      await this.removeSkill(message.skillId);
      return;
    }

    if (message.type === "addMcpServer") {
      await this.addMcpServer();
      return;
    }

    if (message.type === "removeMcpServer") {
      await this.removeMcpServer(message.serverId);
      return;
    }

    if (message.type === "reviewCustomInstruction") {
      await this.reviewCustomInstruction(message.revision);
      return;
    }

    if (message.type === "listWorkspaceReferences") {
      await this.listWorkspaceReferences(message.query);
      return;
    }

    if (message.type === "openWorkspaceFile") {
      await this.openWorkspaceFile(message.path);
      return;
    }

    if (message.type === "mentorViaServer") {
      await this.createMentorViaServer(message);
      return;
    }

    if (message.type === "applyPatchToolCall") {
      await this.applyPatchToolCall(message);
      return;
    }

    if (message.type === "executeCommandToolCall") {
      await this.executeCommandToolCall(message);
      return;
    }

    if (message.type === "markConversationActionApproved") {
      await this.markConversationActionApproved(message);
      return;
    }

    if (message.type === "copyText") {
      await vscode.env.clipboard.writeText(message.text);
      return;
    }

    if (message.type === "executeMcpToolCall") {
      await this.executeMcpToolCall(message);
      return;
    }

    if (message.type === "readClipboardText") {
      await this.readClipboardText(message.requestId);
      return;
    }

    if (message.type === "hideView") {
      await this.hideView();
      return;
    }

    if (message.type === "maximizeView") {
      await this.maximizeView();
      return;
    }

  }

  private async checkServer(requestId?: string): Promise<void> {
    try {
      const health = await this.serverClient.health();
      await this.post({
        type: "serverHealth",
        health,
        ...(requestId ? { requestId } : {})
      });
    } catch (error) {
      console.error("[Mentor Code Extension] App Server health check failed", error);
      await this.post({
        type: "serverFailed",
        message: this.genericFailureMessage(),
        ...(requestId ? { requestId } : {})
      });
    }
  }

  public async postAppSettings(): Promise<void> {
    await this.post({
      type: "appSettings",
      settings: await this.readAppSettings()
    });
    this.updateActivityBadge();
  }

  public async migrateConfiguredServerToken(): Promise<void> {
    const result = await this.serverClient.migrateConfiguredTokenToSecretStorage();
    await this.postAppSettings();
    if (result) {
      await this.postServerTokenValidation(result);
    }
  }

  private async saveServerToken(token: string): Promise<void> {
    const trimmed = token.trim();
    await this.serverClient.storeToken(token);
    if (trimmed) {
      this.serverTokenNoticeShown = false;
    }
    await this.postAppSettings();
  }

  private async validateServerToken(token: string | undefined, requestId?: string): Promise<void> {
    if (token !== undefined) {
      const trimmed = token.trim();
      await this.serverClient.storeToken(token);
      if (trimmed) {
        this.serverTokenNoticeShown = false;
      }
    }
    const result = await this.serverClient.validateToken(token);
    await this.postAppSettings();
    await this.postServerTokenValidation(result, requestId);
  }

  private async postServerTokenValidation(result: ServerTokenValidationResult, requestId?: string): Promise<void> {
    await this.post({
      type: "serverTokenValidation",
      status: result.status,
      serverUrl: result.serverUrl,
      ...(requestId ? { requestId } : {})
    });
  }

  private async readAppSettings(): Promise<AppSettings> {
    return {
      ...this.readPreferenceSettings(),
      serverTokenConfigured: await this.serverClient.hasToken(),
      serverToken: await this.serverClient.currentTokenForSettings()
    };
  }

  private readPreferenceSettings(): Omit<AppSettings, "serverTokenConfigured" | "serverToken"> {
    const configuration = vscode.workspace.getConfiguration("mentorCode");
    return {
      sendShortcut: normalizeSendShortcut(configuration.get<unknown>("sendShortcut", DEFAULT_SEND_SHORTCUT)),
      desktopNotificationsEnabled: normalizeBooleanPreference(
        configuration.get<unknown>("desktopNotificationsEnabled", DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED),
        DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED
      ),
      activityBadgeEnabled: normalizeBooleanPreference(
        configuration.get<unknown>("activityBadgeEnabled", DEFAULT_ACTIVITY_BADGE_ENABLED),
        DEFAULT_ACTIVITY_BADGE_ENABLED
      ),
      customInstructionsEnabled: normalizeBooleanPreference(
        configuration.get<unknown>("customInstructionsEnabled", DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED),
        DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED
      )
    };
  }

  private async updateAppSettings(message: Extract<WebviewMessage, { readonly type: "updateAppSettings" }>): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("mentorCode");
    if (message.sendShortcut !== undefined) {
      await configuration.update("sendShortcut", normalizeSendShortcut(message.sendShortcut), vscode.ConfigurationTarget.Global);
    }
    if (message.desktopNotificationsEnabled !== undefined) {
      await configuration.update(
        "desktopNotificationsEnabled",
        normalizeBooleanPreference(message.desktopNotificationsEnabled, DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED),
        vscode.ConfigurationTarget.Global
      );
    }
    if (message.activityBadgeEnabled !== undefined) {
      await configuration.update(
        "activityBadgeEnabled",
        normalizeBooleanPreference(message.activityBadgeEnabled, DEFAULT_ACTIVITY_BADGE_ENABLED),
        vscode.ConfigurationTarget.Global
      );
    }
    if (message.customInstructionsEnabled !== undefined) {
      await configuration.update(
        "customInstructionsEnabled",
        normalizeBooleanPreference(message.customInstructionsEnabled, DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED),
        vscode.ConfigurationTarget.Global
      );
    }
    await this.postAppSettings();
  }

  private async openSettings(): Promise<void> {
    const query = this.extensionSettingsQuery();
    if (query) {
      await vscode.commands.executeCommand("workbench.action.openSettings", query);
      return;
    }

    await vscode.commands.executeCommand("workbench.action.openSettings");
  }

  private async readClipboardText(requestId: string): Promise<void> {
    try {
      await this.post({
        type: "clipboardText",
        requestId,
        text: await vscode.env.clipboard.readText()
      });
    } catch (error) {
      console.error("[Mentor Code Extension] clipboard read failed", error);
      await this.post({ type: "clipboardText", requestId, text: "" });
    }
  }

  private async loadCustomInstruction(): Promise<void> {
    try {
      await this.post({
        type: "customInstructionLoaded",
        document: await this.customInstructionStore.read(),
        maxBytes: CUSTOM_INSTRUCTION_MAX_BYTES
      });
    } catch (error) {
      console.error("[Mentor Code Extension] custom instruction load failed", error);
      await this.post({
        type: "customInstructionLoadFailed",
        message: this.localFailureMessage(error)
      });
    }
  }

  private async saveCustomInstruction(content: string, expectedRevision: string): Promise<void> {
    try {
      await this.post({
        type: "customInstructionSaved",
        document: await this.customInstructionStore.save(content, expectedRevision)
      });
    } catch (error) {
      console.error("[Mentor Code Extension] custom instruction save failed", error);
      const conflictDocument = error instanceof CustomInstructionStoreError && error.code === "conflict"
        ? await this.customInstructionStore.read().catch(() => undefined)
        : undefined;
      await this.post({
        type: "customInstructionSaveFailed",
        code: error instanceof CustomInstructionStoreError ? error.code : "write_failed",
        message: error instanceof Error ? error.message : this.localFailureMessage(error),
        ...(conflictDocument ? { document: conflictDocument } : {})
      });
    }
  }

  private async openCustomInstructionLocation(): Promise<void> {
    try {
      await this.customInstructionStore.initialize();
      const opened = await vscode.env.openExternal(vscode.Uri.file(this.customInstructionStore.directoryPath));
      if (!opened) {
        throw new Error("カスタム指示の保存先をファイルエクスプローラーで開けませんでした。");
      }
    } catch (error) {
      console.error("[Mentor Code Extension] custom instruction location open failed", error);
      await this.post({
        type: "customInstructionLocationOpenFailed",
        message: this.localFailureMessage(error)
      });
    }
  }

  private async reviewCustomInstruction(expectedRevision: string): Promise<void> {
    try {
      const document = await this.customInstructionStore.read();
      if (document.revision !== expectedRevision) {
        await this.post({
          type: "customInstructionReviewFailed",
          revision: expectedRevision,
          message: "AGENTS.mdがレビュー開始前に変更されました。保存完了後に再実行してください。"
        });
        return;
      }

      if (!document.content.trim()) {
        await this.post({
          type: "customInstructionReviewUnavailable",
          revision: document.revision,
          message: "AGENTS.mdが空のため、LLMレビューは実行していません。"
        });
        return;
      }
      if (!vscode.workspace.isTrusted) {
        await this.post({
          type: "customInstructionReviewUnavailable",
          revision: document.revision,
          message: "未信頼ワークスペースではLLMレビューを実行しません。"
        });
        return;
      }
      if (!await this.serverClient.hasToken()) {
        await this.post({
          type: "customInstructionReviewUnavailable",
          revision: document.revision,
          message: "App Serverトークンが未設定のため、LLMレビューを実行できません。"
        });
        return;
      }

      let supported = false;
      try {
        supported = await this.serverClient.supportsCustomInstructionReview();
      } catch (error) {
        console.error("[Mentor Code Extension] custom instruction review capability check failed", error);
      }
      if (!supported) {
        await this.post({
          type: "customInstructionReviewUnavailable",
          revision: document.revision,
          message: "接続中のApp ServerではLLMレビューを利用できません。"
        });
        return;
      }

      const safetyDecision = await this.customInstructionSafetyAudit.sanitize(document.content);
      if (!safetyDecision.accepted) {
        await this.post({
          type: "customInstructionReviewUnavailable",
          revision: document.revision,
          message: safetyDecision.reason
        });
        return;
      }

      await this.post({
        type: "customInstructionReviewLlmStarted",
        revision: document.revision
      });
      const request: CustomInstructionReviewRequest = {
        schemaVersion: CUSTOM_INSTRUCTION_REVIEW_REQUEST_SCHEMA_VERSION,
        approved: true,
        instructionRevision: safetyDecision.sourceRevision,
        customInstruction: safetyDecision.context
      };
      const result = await this.serverClient.createCustomInstructionReview(request);
      await this.post({
        type: "customInstructionReviewCompleted",
        revision: document.revision,
        result
      });
    } catch (error) {
      console.error("[Mentor Code Extension] custom instruction review failed", error);
      await this.post({
        type: "customInstructionReviewFailed",
        revision: expectedRevision,
        message: error instanceof AppClientVersionMismatchError || error instanceof MentorRequestError
          ? error.message
          : this.genericFailureMessage()
      });
    }
  }

  private extensionSettingsQuery(): string | undefined {
    const packageJson = this.context.extension.packageJSON as {
      readonly publisher?: unknown;
      readonly name?: unknown;
    };
    const publisher = typeof packageJson.publisher === "string" ? packageJson.publisher : undefined;
    const name = typeof packageJson.name === "string" ? packageJson.name : undefined;
    return publisher && name ? `@ext:${publisher}.${name}` : undefined;
  }

  private async listWorkspaceReferences(query: string): Promise<void> {
    try {
      const items = await this.scanner.listReferences(query);
      await this.post({
        type: "workspaceReferences",
        query,
        items
      });
    } catch (error) {
      console.error("[Mentor Code Extension] workspace reference listing failed", error);
      await this.post({
        type: "workspaceReferences",
        query,
        items: [],
        message: this.genericFailureMessage()
      });
    }
  }

  private async openWorkspaceFile(path: string): Promise<void> {
    try {
      const uri = await this.resolveWorkspaceFileUri(path);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: false
      });
    } catch (error) {
      console.error("[Mentor Code Extension] workspace file open failed", error);
      await this.post({
        type: "workspaceFileOpenFailed",
        message: this.localFailureMessage(error)
      });
    }
  }

  private async resolveWorkspaceFileUri(path: string): Promise<vscode.Uri> {
    const workspaceFolder = this.workspaceFolder();
    const normalized = this.normalizeWorkspaceFilePath(path);
    const directUri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalized.split("/"));
    if (await this.isExistingWorkspaceFile(directUri)) {
      return directUri;
    }

    const references = await this.scanner.listReferences(normalized, 80);
    const normalizedLower = normalized.toLowerCase();
    const isPathLike = normalized.includes("/");
    const matches = references.filter((reference) => {
      if (reference.kind !== "file") {
        return false;
      }

      const referencePath = reference.path.toLowerCase();
      if (isPathLike) {
        return referencePath === normalizedLower || referencePath.endsWith(`/${normalizedLower}`);
      }

      return this.basename(referencePath) === normalizedLower;
    });

    if (matches.length === 0) {
      throw new Error(`対象ファイルが見つかりません: ${normalized}`);
    }

    const uniquePaths = [...new Set(matches.map((match) => match.path))];
    if (uniquePaths.length > 1) {
      throw new Error(`同名ファイルが複数あります。パスを含めて指定してください: ${uniquePaths.slice(0, 5).join(", ")}`);
    }

    const targetPath = uniquePaths[0];
    if (!targetPath) {
      throw new Error(`対象ファイルが見つかりません: ${normalized}`);
    }

    return vscode.Uri.joinPath(workspaceFolder.uri, ...targetPath.split("/"));
  }

  private normalizeWorkspaceFilePath(path: string): string {
    const normalized = path
      .trim()
      .replace(/^@/, "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/g, "");

    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes("..") ||
      normalized.includes("://") ||
      normalized.includes("\0")
    ) {
      throw new Error(`安全でない相対パスです。対象: ${path}`);
    }

    return normalized;
  }

  private async isExistingWorkspaceFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  }

  private basename(path: string): string {
    return path.split("/").at(-1) ?? path;
  }

  private registerMentorActivity(input: {
    readonly conversationId: string;
    readonly messageId?: string;
    readonly response: MentorResponse;
    readonly hintLevel?: MentorRequest["hintLevel"];
  }): void {
    const snapshot = this.activityTracker.registerResponse({
      responseId: input.messageId ?? this.nextActivityResponseId(),
      conversationId: input.conversationId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      response: input.response,
      hintLevel: normalizeActivityHintLevel(input.hintLevel),
      unread: !this.isMentorViewReadable()
    });

    this.updateActivityBadge();
    this.notifyMentorResponse(input.response, snapshot);
  }

  private resolveActivityAction(input: {
    readonly conversationId?: string;
    readonly messageId: string;
    readonly action: MentorActivityAction;
    readonly markRead?: boolean;
  }): void {
    this.activityTracker.resolveAction(input);
    this.updateActivityBadge();
  }

  private notifyMentorResponse(response: MentorResponse, snapshot: { readonly badgeValue: number }): void {
    if (!this.readPreferenceSettings().desktopNotificationsEnabled) {
      return;
    }

    const badgeSummary = snapshot.badgeValue > 0
      ? `未読・対応待ち: ${snapshot.badgeValue}件`
      : "App Serverから応答を受信しました。";
    this.toastNotifier.notify({
      title: "Mentor Code",
      message: `${response.title}\n${badgeSummary}`,
      onClick: () => this.reveal()
    });
  }

  private updateActivityBadge(): void {
    if (!this.view) {
      return;
    }

    const snapshot = this.activityTracker.snapshot();
    if (!this.readPreferenceSettings().activityBadgeEnabled || snapshot.badgeValue === 0) {
      this.view.badge = undefined;
      return;
    }

    this.view.badge = {
      value: snapshot.badgeValue,
      tooltip: snapshot.tooltip
    };
  }

  private isMentorViewReadable(): boolean {
    return Boolean(this.view?.visible && vscode.window.state.focused);
  }

  private nextActivityResponseId(): string {
    return `response:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }

  private async createMentorViaServer(message: Extract<WebviewMessage, { readonly type: "mentorViaServer" }>): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await this.post({
        type: "serverFailed",
        message: "未信頼ワークスペースではApp Server呼び出しを無効化しています。"
      });
      return;
    }

    if (!await this.serverClient.hasToken()) {
      await this.promptForMissingServerToken();
      await this.post({
        type: "serverFailed",
        message: APP_SERVER_TOKEN_MISSING_MESSAGE
      });
      return;
    }

    if (message.conversationId) {
      this.activityTracker.markConversationRead(message.conversationId);
      this.updateActivityBadge();
    }

    try {
      await this.postServerMentorProgress(
        message.contextPackage
          ? "承認済みコンテキストを確認しています。"
          : "送信前のコンテキストを準備しています。"
      );
      const contextResult = message.contextPackage
        ? {
          contextPackage: message.contextPackage
        }
        : await this.scanner.collectMentorContext(message.request, message.references ?? []);
      const contextPackage = contextResult.contextPackage;
      const request: MentorRequest = {
        ...message.request,
        ...("workspaceMap" in contextResult ? { workspaceMap: contextResult.workspaceMap } : {}),
        guardSummary: contextPackage.summary
      };
      await this.postServerMentorProgress("送信前の安全確認を実行しています。");
      const auditDecision = await this.sendTimeAudit.audit(request, contextPackage, {
        ...(message.workspaceInspection ? {} : { skipTargetAuditKeys: this.reviewedTargetAuditKeys })
      });
      if (!auditDecision.accepted) {
        console.error("[Mentor Code Extension] send-time audit rejected mentor request", auditDecision.reason);
        await this.post({
          type: "serverFailed",
          message: this.genericFailureMessage()
        });
        return;
      }

      const customInstruction = await this.customInstructionForExternalLlm();
      if (customInstruction === null) {
        return;
      }
      const skillContext = await this.skillContextForExternalLlm(auditDecision.request.task);
      if (skillContext === null) {
        return;
      }
      const mcpContext = await this.mcpContextForExternalLlm(auditDecision.request.task);
      if (mcpContext === null) {
        return;
      }

      const conversationState = message.continuation
        ? await this.loadConversationForContinuation(message)
        : await this.persistUserMessage(message, auditDecision.request);
      if (!conversationState) {
        return;
      }

      await this.postServerMentorProgress("会話履歴を確認し、App Serverへ送る内容を確定しています。");
      const conversationContext = this.conversations.buildContext(conversationState.current, {
        ...(message.editResult ? { lastEditResult: message.editResult } : {}),
        ...(message.commandResult ? { lastCommandResult: message.commandResult } : {})
      });
      console.log("[Mentor Code Extension] mentor conversation context prepared", {
        conversationId: conversationContext.conversationId,
        recentMessages: conversationContext.recentMessages.length,
        approvedActions: conversationContext.approvedActions.length,
        hasCompactedSummary: Boolean(conversationContext.compactedSummary),
        hasEditResult: Boolean(conversationContext.lastEditResult),
        hasCommandResult: Boolean(conversationContext.lastCommandResult)
      });

      await this.postServerMentorProgress("App Serverへ送信しています。回答を生成中です。");
      const result = await this.serverClient.createMentorResponse(
        auditDecision.request,
        contextPackage,
        message.approved,
        conversationContext,
        (event) => this.postServerMentorProgress(event.message, true),
        customInstruction,
        skillContext,
        mcpContext
      );
      const securityFeedback = await this.securityFeedback(
        auditDecision,
        Boolean(message.workspaceInspection),
        contextPackage
      );
      const assistantMessageId = await this.persistAssistantMessage(
        conversationState.currentConversationId,
        result.response,
        auditDecision.request.hintLevel
      );
      this.registerMentorActivity({
        conversationId: conversationState.currentConversationId,
        ...(assistantMessageId ? { messageId: assistantMessageId } : {}),
        response: result.response,
        hintLevel: auditDecision.request.hintLevel
      });
      await this.post({
        type: "serverMentorCompleted",
        result: {
          ...result,
          conversationId: conversationState.currentConversationId,
          ...(assistantMessageId ? { assistantMessageId } : {}),
          ...(auditDecision.request.hintLevel ? { hintLevel: auditDecision.request.hintLevel } : {}),
          contextPackage,
          ...(securityFeedback ? { securityFeedback } : {}),
          safety: [
            auditDecision.reason,
            result.safety
          ].filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n")
        }
      });
    } catch (error) {
      console.error("[Mentor Code Extension] mentorViaServer failed", error);
      await this.post({
        type: "serverFailed",
        message: error instanceof AppClientVersionMismatchError || error instanceof MentorRequestError
          ? error.message
          : "応答を生成できませんでした。詳細はログを確認してください。"
      });
    }
  }

  private async customInstructionForExternalLlm(): Promise<CustomInstructionContext | undefined | null> {
    if (!this.readPreferenceSettings().customInstructionsEnabled) {
      return undefined;
    }
    const document = await this.customInstructionStore.read();
    if (document.content.length === 0) {
      return undefined;
    }

    const decision = await this.customInstructionSafetyAudit.sanitize(document.content);
    if (!decision.accepted) {
      console.error("[Mentor Code Extension] custom instruction safety check rejected the request", {
        revision: document.revision,
        byteLength: document.byteLength,
        findingCount: decision.result.findings.length
      });
      await this.post({
        type: "serverFailed",
        message: `${decision.reason} カスタム指示を修正してから再実行してください。`
      });
      return null;
    }

    return decision.context;
  }

  private async skillContextForExternalLlm(task: string): Promise<SkillExecutionContext | undefined | null> {
    const enabled = vscode.workspace.getConfiguration("mentorCode").get<boolean>("skillsEnabled", true);
    if (!enabled) {
      return undefined;
    }

    if (!this.skillRegistry.hasExplicitInvocation(task)) {
      return undefined;
    }
    const activation = await this.skillRegistry.activateExplicit(task);
    if (activation.discoveryIssues.length > 0) {
      console.warn("[Mentor Code Extension] Skill discovery issues", activation.discoveryIssues.map((issue) => ({
        sourceId: issue.sourceId,
        directoryName: issue.directoryName,
        code: issue.code
      })));
    }
    if (activation.activationIssues.length > 0) {
      await this.post({
        type: "serverFailed",
        message: activation.activationIssues.map((issue) => issue.message).join("\n")
      });
      return null;
    }
    if (activation.catalogIssues && activation.catalogIssues.length > 0) {
      console.warn("[Mentor Code Extension] Skill catalog issues", activation.catalogIssues.map((issue) => ({
        name: issue.name,
        code: issue.code
      })));
    }
    if (activation.activeSkills.length === 0) {
      return undefined;
    }

    await this.postServerMentorProgress(
      `${activation.activeSkills.map((skill) => `$${skill.name}`).join("、")} を安全確認して適用しています。`
    );
    return { activeSkills: activation.activeSkills };
  }

  private skillRoots(): readonly SkillRoot[] {
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      sourceId: this.skillSourceId(folder.uri.toString()),
      scope: "workspace" as const,
      directoryPath: join(folder.uri.fsPath, ".agents", "skills")
    }));
    return [
      ...workspaceRoots,
      {
        sourceId: "user-agents",
        scope: "user" as const,
        directoryPath: join(homedir(), ".agents", "skills")
      },
      ...((vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        sourceId: `${this.skillSourceId(folder.uri.toString())}-claude`,
        scope: "workspace" as const,
        directoryPath: join(folder.uri.fsPath, ".claude", "skills")
      }))),
      {
        sourceId: "user-claude",
        scope: "user" as const,
        directoryPath: join(homedir(), ".claude", "skills")
      }
    ];
  }

  public async handleMcpOAuthUri(uri: vscode.Uri): Promise<void> {
    const match = /^\/mcp-oauth\/([^/]+)$/.exec(uri.path);
    const serverId = match?.[1] ? decodeURIComponent(match[1]) : "";
    if (!serverId) {
      await vscode.window.showErrorMessage("MCP OAuthコールバックの対象を確認できませんでした。");
      return;
    }
    try {
      await this.mcpManager.completeOAuth(serverId, new URLSearchParams(uri.query));
      await vscode.window.showInformationMessage("MCP OAuth認証が完了しました。");
      await this.postCapabilityCatalog();
    } catch (error) {
      console.error("[Mentor Code Extension] MCP OAuth callback failed", error);
      await this.mcpManager.clearAuthentication(serverId);
      await vscode.window.showErrorMessage("MCP OAuth認証を完了できませんでした。認証を最初からやり直してください。");
    }
  }

  private async installSkillFromGit(): Promise<void> {
    const source = await vscode.window.showInputBox({
      title: "GitからSkillを追加",
      prompt: "HTTPS URLを指定します。ブランチと場所は #ref=main&path=skills/example の形式で指定できます。",
      placeHolder: "https://github.com/example/repository.git#ref=main&path=skills/example",
      ignoreFocusOut: true
    });
    if (!source) return;
    await this.installSkillCandidate("git", source);
  }

  private async installSkillFromLocal(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: "追加するSkillフォルダーを選択",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "監査対象として選択"
    });
    const directory = selected?.[0]?.fsPath;
    if (!directory) return;
    await this.installSkillCandidate("local", directory);
  }

  private async installSkillCandidate(kind: "git" | "local", source: string): Promise<void> {
    const inspect = await vscode.window.showWarningMessage(
      "第三者製Skillを隔離領域で検査します。",
      {
        modal: true,
        detail: `${source}\n\nローカルLLMとApp Serverへ、秘密値を除去した対象内容を送って説明を作成します。Gitの場合、この許可後に取得します。スクリプトは実行しません。`
      },
      "検査を許可"
    );
    if (inspect !== "検査を許可") return;

    let candidate: Awaited<ReturnType<SkillManagementService["prepareLocal"]>> | undefined;
    try {
      candidate = kind === "git"
        ? await this.skillManagement.prepareGit(source)
        : await this.skillManagement.prepareLocal(source);
      const reviews = await this.reviewCapability("skill", candidate.name, candidate.source, candidate.auditedContent, candidate.warnings);
      const install = await vscode.window.showWarningMessage(
        `$${candidate.name} をインストールしますか？`,
        { modal: true, detail: this.reviewDetail(reviews, candidate.manifest.description) },
        "インストール"
      );
      if (install !== "インストール") {
        await this.skillManagement.reject(candidate.id);
        return;
      }
      const targetRoot = await this.selectSkillTargetRoot();
      if (!targetRoot) {
        await this.skillManagement.reject(candidate.id);
        return;
      }
      const installedPath = await this.skillManagement.install(candidate.id, targetRoot);
      const records = this.context.globalState.get<Record<string, { source: string; revision: string; path: string }>>("mentorCode.skillSources.v1", {});
      await this.context.globalState.update("mentorCode.skillSources.v1", {
        ...records,
        [candidate.name]: { source: candidate.source, revision: candidate.revision, path: installedPath }
      });
      await vscode.window.showInformationMessage(`$${candidate.name} を追加しました。`);
      await this.postCapabilityCatalog();
    } catch (error) {
      if (candidate) await this.skillManagement.reject(candidate.id).catch(() => undefined);
      console.error("[Mentor Code Extension] Skill installation failed", error);
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "Skillを追加できませんでした。");
    }
  }

  private async updateSkill(skillId: string): Promise<void> {
    const skill = (await this.skillRepository.discover()).skills.find((entry) => entry.id === skillId);
    if (!skill) return;
    const record = this.context.globalState.get<Record<string, { source: string; revision: string; path: string }>>("mentorCode.skillSources.v1", {})[skill.manifest.name];
    if (!record) {
      await vscode.window.showWarningMessage("このSkillにはアプリが記録した更新元がありません。");
      return;
    }
    const local = record.source.startsWith("local:");
    await this.installSkillCandidate(local ? "local" : "git", local ? record.source.slice(6) : record.source);
  }

  private async removeSkill(skillId: string): Promise<void> {
    const skill = (await this.skillRepository.discover()).skills.find((entry) => entry.id === skillId);
    if (!skill) return;
    const approved = await vscode.window.showWarningMessage(
      `$${skill.manifest.name} を削除しますか？`,
      { modal: true, detail: "Skillはアプリの隔離ごみ箱へ移動します。会話履歴や外部に保存された内容は削除されません。" },
      "隔離して削除"
    );
    if (approved !== "隔離して削除") return;
    const trashRoot = join(this.context.globalStorageUri.fsPath, "skill-trash");
    await mkdir(trashRoot, { recursive: true });
    const trashPath = join(trashRoot, `${Date.now()}-${randomUUID()}-${skill.manifest.name}`);
    await rename(skill.directoryPath, trashPath);
    const records = { ...this.context.globalState.get<Record<string, { source: string; revision: string; path: string }>>("mentorCode.skillSources.v1", {}) };
    delete records[skill.manifest.name];
    await this.context.globalState.update("mentorCode.skillSources.v1", records);
    await vscode.window.showInformationMessage(`$${skill.manifest.name} を隔離しました。復元先: ${trashPath}`);
    await this.postCapabilityCatalog();
  }

  private async selectSkillTargetRoot(): Promise<string | undefined> {
    const choices = [{ label: "ユーザー共通", description: "~/.agents/skills", path: join(homedir(), ".agents", "skills") }];
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace) choices.unshift({ label: "このワークスペース", description: ".agents/skills", path: join(workspace, ".agents", "skills") });
    return (await vscode.window.showQuickPick(choices, { placeHolder: "Skillの配置先を選択", ignoreFocusOut: true }))?.path;
  }

  private async addMcpServer(): Promise<void> {
    const transport = await vscode.window.showQuickPick([
      { label: "HTTP", description: "HTTPS（localhostのみHTTP可）", value: "http" as const },
      { label: "STDIO", description: "ローカルプロセスをシェルなしで起動", value: "stdio" as const }
    ], { placeHolder: "MCPの接続方式", ignoreFocusOut: true });
    if (!transport) return;
    const id = await vscode.window.showInputBox({ title: "MCPサーバーID", prompt: "小文字英数字とハイフン", validateInput: (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? undefined : "形式が正しくありません。" });
    if (!id) return;
    const displayName = await vscode.window.showInputBox({ title: "MCP表示名", prompt: "接続確認画面に表示します。" });
    if (!displayName) return;
    let raw: unknown;
    if (transport.value === "http") {
      const url = await vscode.window.showInputBox({ title: "MCP URL", placeHolder: "https://mcp.example.com/mcp", ignoreFocusOut: true });
      if (!url) return;
      const auth = await vscode.window.showQuickPick([
        { label: "OAuth", value: "oauth" as const },
        { label: "Bearer token", value: "bearer" as const },
        { label: "認証なし", value: "none" as const }
      ], { placeHolder: "認証方式", ignoreFocusOut: true });
      if (!auth) return;
      raw = { id, displayName, transport: "http", url, auth: auth.value, enabled: true };
    } else {
      const command = await vscode.window.showInputBox({ title: "STDIO command", prompt: "シェル構文ではなく実行ファイル名または絶対パス", ignoreFocusOut: true });
      if (!command) return;
      const argsText = await vscode.window.showInputBox({ title: "STDIO arguments", prompt: "引数をJSON配列で指定", value: "[]", ignoreFocusOut: true });
      if (argsText === undefined) return;
      let args: unknown;
      try { args = JSON.parse(argsText); } catch { await vscode.window.showErrorMessage("argumentsはJSON配列で指定してください。"); return; }
      raw = { id, displayName, transport: "stdio", command, args, auth: "none", enabled: true };
    }
    const normalized = this.mcpServerConfiguration.normalize([raw]);
    const server = normalized.servers[0];
    if (!server) { await vscode.window.showErrorMessage(normalized.issues[0]?.message ?? "MCP設定が不正です。"); return; }
    const inspect = await vscode.window.showWarningMessage(
      "第三者製MCPの設定を監査します。",
      { modal: true, detail: `${this.mcpSource(server)}\n\nこの許可では接続・プロセス起動を行いません。ローカルLLMとApp Serverが設定内容を説明します。` },
      "監査を許可"
    );
    if (inspect !== "監査を許可") return;
    try {
      const content = JSON.stringify(server, null, 2);
      const reviews = await this.reviewCapability("mcp", server.id, this.mcpSource(server), content, server.transport === "stdio" ? ["ローカルコマンドを起動します。"] : []);
      const approve = await vscode.window.showWarningMessage(
        `${server.displayName} への接続を許可しますか？`,
        { modal: true, detail: this.reviewDetail(reviews, server.transport === "stdio" ? `実行: ${server.command} ${server.args.join(" ")}` : `接続先: ${server.url}`) },
        "追加して接続を許可"
      );
      if (approve !== "追加して接続を許可") return;
      const configuration = vscode.workspace.getConfiguration("mentorCode");
      const current = this.configuredMcpServers().filter((entry) => entry.id !== server.id);
      await configuration.update("mcpServers", [...current, server], vscode.ConfigurationTarget.Global);
      await configuration.update("mcpEnabled", true, vscode.ConfigurationTarget.Global);
      const approvals = this.context.globalState.get<Record<string, string>>("mentorCode.mcpApprovals.v1", {});
      await this.context.globalState.update("mentorCode.mcpApprovals.v1", { ...approvals, [server.id]: this.mcpRevision(server) });
      if (server.transport !== "stdio" && server.auth === "bearer") {
        const token = await vscode.window.showInputBox({ title: `${server.displayName} Bearer token`, password: true, prompt: "SecretStorageだけに保存します。", ignoreFocusOut: true });
        if (token) await this.mcpManager.setToken(server.id, token);
      }
      await vscode.window.showInformationMessage(`${server.displayName} を追加しました。OAuthは初回接続時にブラウザーで認証します。`);
      await this.postCapabilityCatalog();
    } catch (error) {
      console.error("[Mentor Code Extension] MCP installation failed", error);
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : "MCPを追加できませんでした。");
    }
  }

  private async removeMcpServer(serverId: string): Promise<void> {
    const server = this.configuredMcpServers().find((entry) => entry.id === serverId);
    if (!server) return;
    const approved = await vscode.window.showWarningMessage(`${server.displayName} を削除しますか？`, { modal: true, detail: "設定とBearer tokenを削除します。会話履歴内の過去の表示は削除されません。" }, "削除");
    if (approved !== "削除") return;
    await vscode.workspace.getConfiguration("mentorCode").update("mcpServers", this.configuredMcpServers().filter((entry) => entry.id !== serverId), vscode.ConfigurationTarget.Global);
    await this.mcpManager.clearAuthentication(serverId);
    const approvals = { ...this.context.globalState.get<Record<string, string>>("mentorCode.mcpApprovals.v1", {}) };
    delete approvals[serverId];
    await this.context.globalState.update("mentorCode.mcpApprovals.v1", approvals);
    await this.postCapabilityCatalog();
  }

  private async reviewCapability(kind: CapabilityKind, identifier: string, source: string, content: string, warnings: readonly string[]): Promise<{ local: LocalCapabilityAudit; server: CapabilityReviewResult }> {
    const local = await this.capabilityReviewer.review({ kind, identifier, source, content, warnings });
    if (local.status !== "completed") throw new Error(local.summary);
    const revision = createHash("sha256").update(content, "utf8").digest("hex");
    const server = await this.serverClient.createCapabilityReview({ schemaVersion: CAPABILITY_REVIEW_REQUEST_SCHEMA_VERSION, approved: true, revision, kind, identifier, source, content, warnings });
    return { local, server };
  }

  private reviewDetail(reviews: { local: LocalCapabilityAudit; server: CapabilityReviewResult }, subject: string): string {
    const review = reviews.server.review;
    return [subject, "", `ローカルLLM監査: ${reviews.local.summary}`, "", `App Server説明: ${review.summary}`, ...review.capabilities.map((item) => `機能: ${item}`), ...review.data_access.map((item) => `データ: ${item}`), ...review.risks.map((item) => `リスク: ${item}`)].join("\n").slice(0, 12000);
  }

  private async postCapabilityCatalog(): Promise<void> {
    const discovered = await this.skillRepository.discover();
    const sources = this.context.globalState.get<Record<string, { source: string; revision: string; path: string }>>("mentorCode.skillSources.v1", {});
    const skills = await Promise.all(discovered.skills.map(async (skill) => {
      const readme = await readFile(join(skill.directoryPath, "README.md"), "utf8").catch(() => "");
      return { id: skill.id, name: skill.manifest.name, description: skill.manifest.description, scope: skill.scope, source: sources[skill.manifest.name]?.source ?? skill.directoryPath, managed: Boolean(sources[skill.manifest.name]), readme: readme.slice(0, 128 * 1024) };
    }));
    const approvals = this.context.globalState.get<Record<string, string>>("mentorCode.mcpApprovals.v1", {});
    await this.post({ type: "capabilityCatalog", skills, mcpServers: this.configuredMcpServers().map((server) => ({ ...server, approved: approvals[server.id] === this.mcpRevision(server), source: this.mcpSource(server) })), issues: discovered.issues.map((issue) => issue.message) });
  }

  private mcpSource(server: McpServerDefinition): string {
    return server.transport === "stdio" ? `stdio:${server.command}` : server.url;
  }

  private mcpRevision(server: McpServerDefinition): string {
    return createHash("sha256").update(JSON.stringify(server), "utf8").digest("hex");
  }

  private configuredMcpServers(): readonly McpServerDefinition[] {
    const inspected = vscode.workspace.getConfiguration("mentorCode").inspect<unknown>("mcpServers");
    return this.mcpServerConfiguration.normalize(inspected?.globalValue ?? []).servers;
  }

  private approvedMcpServers(): readonly McpServerDefinition[] {
    const approvals = this.context.globalState.get<Record<string, string>>("mentorCode.mcpApprovals.v1", {});
    return this.configuredMcpServers().filter((server) => approvals[server.id] === this.mcpRevision(server));
  }

  private async mcpContextForExternalLlm(task: string): Promise<McpToolContext | undefined | null> {
    const requestedIds = [...task.matchAll(/\$mcp:([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map((match) => match[1]).filter((id): id is string => Boolean(id));
    const enabled = vscode.workspace.getConfiguration("mentorCode").get<boolean>("mcpEnabled", false);
    if (!enabled) {
      return requestedIds.length > 0 ? this.rejectMcpForPrompt("MCP機能が無効です。") : undefined;
    }
    if (requestedIds.length === 0) return undefined;
    const approvedIds = new Set(this.approvedMcpServers().map((server) => server.id));
    const unavailable = requestedIds.filter((id) => !approvedIds.has(id));
    if (unavailable.length > 0) return this.rejectMcpForPrompt(`未承認または未設定のMCPです: ${unavailable.join("、")}`);
    await this.postServerMentorProgress("設定済みMCPサーバーからTools一覧を確認しています。");
    const result = await this.mcpManager.discoverTools(requestedIds);
    if (result.issues.length > 0) {
      console.warn("[Mentor Code Extension] MCP discovery issues", result.issues);
    }
    if (requestedIds.length > 0 && !result.context?.tools.some((tool) => requestedIds.includes(tool.serverId))) {
      return this.rejectMcpForPrompt("指定されたMCPへ接続できませんでした。OAuth認証が開始された場合は、認証後に再送できます。");
    }
    return requestedIds.length > 0 && result.context
      ? { tools: result.context.tools.filter((tool) => requestedIds.includes(tool.serverId)) }
      : result.context;
  }

  private async rejectMcpForPrompt(reason: string): Promise<undefined | null> {
    const choice = await vscode.window.showWarningMessage(
      "MCP接続を行わずに処理しますか？",
      { modal: true, detail: `${reason}\n\n「MCPなしで送信」を選ぶとプロンプト本文はそのまま送信します。` },
      "MCPなしで送信",
      "送信を中止"
    );
    return choice === "MCPなしで送信" ? undefined : null;
  }

  private mcpServers(): readonly McpServerDefinition[] {
    const result = this.mcpServerConfiguration.normalize(this.configuredMcpServers());
    if (result.issues.length > 0) {
      console.warn("[Mentor Code Extension] invalid global MCP server settings", result.issues);
    }
    return result.servers;
  }

  public async setMcpServerToken(): Promise<void> {
    const server = await this.selectMcpServer("Bearer tokenを設定するMCPサーバーを選択してください");
    if (!server) {
      return;
    }
    const token = await vscode.window.showInputBox({
      title: `${server.displayName} MCP Bearer Token`,
      prompt: "TokenはVS Code SecretStorageに保存され、設定ファイルへは書き込みません。",
      password: true,
      ignoreFocusOut: true
    });
    if (token === undefined) {
      return;
    }
    await this.mcpManager.setToken(server.id, token);
    await vscode.window.showInformationMessage(`${server.displayName} のMCP tokenを保存しました。`);
  }

  public async clearMcpServerToken(): Promise<void> {
    const server = await this.selectMcpServer("Bearer tokenを削除するMCPサーバーを選択してください");
    if (!server) {
      return;
    }
    await this.mcpManager.clearToken(server.id);
    await vscode.window.showInformationMessage(`${server.displayName} のMCP tokenを削除しました。`);
  }

  private async selectMcpServer(placeHolder: string): Promise<McpServerDefinition | undefined> {
    const servers = this.mcpServers();
    if (servers.length === 0) {
      await vscode.window.showWarningMessage("グローバル設定 mentorCode.mcpServers にMCPサーバーを追加してください。");
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      servers.map((server) => ({ label: server.displayName, description: server.id, server })),
      { placeHolder, ignoreFocusOut: true }
    );
    return selected?.server;
  }

  private skillSourceId(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  }

  private async applyPatchToolCall(message: Extract<WebviewMessage, { readonly type: "applyPatchToolCall" }>): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await this.post({
        type: "patchToolCallFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: "未信頼ワークスペースでは編集案の適用を無効化しています。"
      });
      return;
    }

    try {
      const result = await this.patchApplier.apply(message.toolCall);
      if (message.messageId) {
        this.resolveActivityAction({
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          messageId: message.messageId,
          action: "applyPatch",
          markRead: true
        });
        await this.persistApprovedAction({
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          messageId: message.messageId,
          action: "applyPatch"
        });
      }
      await this.post({
        type: "patchToolCallApplied",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        result
      });
    } catch (error) {
      console.error("[Mentor Code Extension] edit proposal apply failed", error);
      await this.post({
        type: "patchToolCallFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: this.localFailureMessage(error),
        ...(error instanceof WorkspacePatchApplyError ? { result: error.result } : {})
      });
    }
  }

  private async executeCommandToolCall(message: Extract<WebviewMessage, { readonly type: "executeCommandToolCall" }>): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await this.post({
        type: "commandExecutionFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: "未信頼ワークスペースではコマンド実行を無効化しています。"
      });
      return;
    }

    try {
      const result = await this.commandExecutor.execute(message.toolCall, {
        onOutput: async (snapshot) => {
          await this.post({
            type: "commandExecutionOutput",
            ...(message.messageId ? { messageId: message.messageId } : {}),
            snapshot
          });
        }
      });
      await this.post({
        type: "commandExecutionCompleted",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        result
      });
    } catch (error) {
      console.error("[Mentor Code Extension] command execution failed", error);
      await this.post({
        type: "commandExecutionFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: this.localFailureMessage(error)
      });
    }
  }

  private async executeMcpToolCall(
    message: Extract<WebviewMessage, { readonly type: "executeMcpToolCall" }>
  ): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await this.post({
        type: "mcpToolExecutionFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: "未信頼ワークスペースではMCP Tool実行を無効化しています。"
      });
      return;
    }
    if (!vscode.workspace.getConfiguration("mentorCode").get<boolean>("mcpEnabled", false)) {
      await this.post({
        type: "mcpToolExecutionFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: "MCP機能が無効です。"
      });
      return;
    }

    try {
      const result = await this.mcpManager.callTool({
        serverId: message.toolCall.serverId,
        toolName: message.toolCall.toolName,
        arguments: message.toolCall.arguments
      });
      await this.post({
        type: "mcpToolExecutionCompleted",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        result
      });
    } catch (error) {
      console.error("[Mentor Code Extension] MCP Tool execution failed", error);
      await this.post({
        type: "mcpToolExecutionFailed",
        ...(message.messageId ? { messageId: message.messageId } : {}),
        message: this.localFailureMessage(error)
      });
    }
  }

  private async markConversationActionApproved(
    message: Extract<WebviewMessage, { readonly type: "markConversationActionApproved" }>
  ): Promise<void> {
    this.resolveActivityAction({
      ...(message.conversationId ? { conversationId: message.conversationId } : {}),
      messageId: message.messageId,
      action: message.action,
      markRead: true
    });

    try {
      await this.conversations.markMessageActionApproved({
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        messageId: message.messageId,
        action: message.action
      });
    } catch (error) {
      console.error("[Mentor Code Extension] approval state persistence failed", error);
      await this.post({
        type: "conversationPersistenceFailed",
        message: this.genericFailureMessage()
      });
    }
  }

  private genericFailureMessage(): string {
    return "処理に失敗しました。詳細はログを確認してください。";
  }

  private localFailureMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return this.genericFailureMessage();
  }

  private async hideView(): Promise<void> {
    await this.runWorkbenchCommand("workbench.action.closeAuxiliaryBar");
    await this.waitForWorkbenchLayout();

    if (this.view?.visible) {
      await this.runWorkbenchCommand("workbench.action.closeSidebar");
      await this.waitForWorkbenchLayout();
    }

    if (this.view?.visible) {
      await this.runWorkbenchCommand("workbench.action.toggleSidebarVisibility");
    }
  }

  private async maximizeView(): Promise<void> {
    await this.runFirstAvailableWorkbenchCommand([
      "workbench.action.toggleMaximizedPanel",
      "workbench.action.toggleAuxiliaryBar"
    ]);
  }

  private async runFirstAvailableWorkbenchCommand(commands: readonly string[]): Promise<void> {
    for (const command of commands) {
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch {
        // Try the next VS Code command name. Command availability differs by workbench location.
      }
    }
  }

  private async runWorkbenchCommand(command: string): Promise<boolean> {
    try {
      await vscode.commands.executeCommand(command);
      return true;
    } catch {
      return false;
    }
  }

  private waitForWorkbenchLayout(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  private async post(message: unknown): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private async postServerMentorProgress(message: string, factual = false): Promise<void> {
    await this.post({
      type: "serverMentorProgress",
      message,
      factual
    });
  }

  private async promptForMissingServerToken(): Promise<void> {
    if (await this.serverClient.hasToken()) {
      return;
    }

    await this.post({
      type: "serverTokenMissing",
      message: APP_SERVER_TOKEN_MISSING_MESSAGE
    });

    if (this.serverTokenNoticeShown) {
      return;
    }

    this.serverTokenNoticeShown = true;
    const selection = await vscode.window.showWarningMessage(
      APP_SERVER_TOKEN_MISSING_MESSAGE,
      "サイドバーを開く"
    );
    if (selection === "サイドバーを開く") {
      await this.reveal();
    }
  }

  private async postConversationState(state: ConversationState): Promise<void> {
    await this.post({
      type: "conversationState",
      state
    });
  }

  private async persistUserMessage(
    message: Extract<WebviewMessage, { readonly type: "mentorViaServer" }>,
    request: MentorRequest
  ): Promise<ConversationState | undefined> {
    try {
      const state = await this.conversations.appendUserMessage({
        ...(message.startNewConversation ? { startNewConversation: true } : {}),
        ...(!message.startNewConversation && message.conversationId ? { conversationId: message.conversationId } : {}),
        ...(message.clientMessageId ? { messageId: message.clientMessageId } : {}),
        request,
        references: message.references ?? [],
        workspaceInspection: Boolean(message.workspaceInspection)
      });
      if (message.startNewConversation) {
        await this.post({
          type: "conversationActivated",
          conversationId: state.currentConversationId,
          title: state.current.title,
          conversations: state.conversations
        });
      } else {
        await this.post({
          type: "conversationSummaries",
          conversations: state.conversations
        });
      }
      return state;
    } catch (error) {
      console.error("[Mentor Code Extension] user message persistence failed", error);
      await this.post({
        type: "conversationPersistenceFailed",
        message: this.genericFailureMessage()
      });
      return undefined;
    }
  }

  private async loadConversationForContinuation(
    message: Extract<WebviewMessage, { readonly type: "mentorViaServer" }>
  ): Promise<ConversationState | undefined> {
    if (!message.conversationId) {
      console.error("[Mentor Code Extension] continuation request is missing conversationId", message.continuation);
      await this.post({
        type: "serverFailed",
        message: this.genericFailureMessage()
      });
      return undefined;
    }

    try {
      return await this.conversations.loadConversation(message.conversationId);
    } catch (error) {
      console.error("[Mentor Code Extension] continuation conversation load failed", error);
      await this.post({
        type: "conversationPersistenceFailed",
        message: this.genericFailureMessage()
      });
      return undefined;
    }
  }

  private async securityFeedback(
    auditDecision: SendTimeQuickAuditDecision,
    includePreviouslyReviewed: boolean,
    contextPackage: ContextPackage
  ): Promise<string | undefined> {
    const targetFeedbackItems = auditDecision.targetResults
      .map((result) => this.targetResultEducationFeedbackItem(result))
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    const workspaceFeedbackItems = includePreviouslyReviewed
      ? this.contextPackageEducationFeedbackItems(contextPackage)
      : [];
    const feedbackItems = includePreviouslyReviewed && workspaceFeedbackItems.length > 0
      ? workspaceFeedbackItems
      : targetFeedbackItems;

    await this.rememberTargetAuditKeys(auditDecision.targetAuditKeys);

    if (feedbackItems.length === 0) {
      return undefined;
    }

    return [
      includePreviouslyReviewed
        ? "ワークスペース内で確認が必要な項目です。"
        : "今回の送信内容で確認が必要な項目です。",
      ...feedbackItems
    ].join("\n");
  }

  private contextPackageEducationFeedbackItems(contextPackage: ContextPackage): readonly string[] {
    const items: string[] = [];
    const seenPaths = new Set<string>();
    for (const file of contextPackage.files) {
      if (!file.localLlmReview || seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      items.push(this.localLlmReviewFeedbackItem(file.path, file.localLlmReview));
    }
    for (const file of contextPackage.blockedFiles) {
      if (!file.localLlmReview || seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      items.push(this.localLlmReviewFeedbackItem(file.path, file.localLlmReview));
    }
    return items;
  }

  private targetResultEducationFeedbackItem(result: FileGuardResult): string | undefined {
    const review = result.localLlmReview;
    if (!review) {
      return undefined;
    }

    return this.localLlmReviewFeedbackItem(result.path, review);
  }

  private localLlmReviewFeedbackItem(path: string, review: LocalLlmReview): string {
    const riskPoints = review.riskPoints.slice(0, 2).join(" / ");
    return [
      `- ${path}: ${review.educationSummary}`,
      `推奨: ${review.recommendedAction}`,
      ...(riskPoints ? [`注意: ${riskPoints}`] : [])
    ].join(" ");
  }

  private async rememberTargetAuditKeys(keys: readonly string[]): Promise<void> {
    let changed = false;
    for (const key of keys) {
      if (this.reviewedTargetAuditKeys.has(key)) {
        continue;
      }

      this.reviewedTargetAuditKeys.add(key);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await this.context.globalState.update(
      this.educationFeedbackStorageKey,
      [...this.reviewedTargetAuditKeys].slice(-500)
    );
  }

  private async persistAssistantMessage(
    conversationId: string | undefined,
    response: MentorResponse,
    hintLevel: MentorRequest["hintLevel"]
  ): Promise<string | undefined> {
    try {
      const state = await this.conversations.appendAssistantMessage({
        ...(conversationId ? { conversationId } : {}),
        ...(hintLevel ? { hintLevel } : {}),
        response
      });
      const message = state.current.messages.at(-1);
      return message?.kind === "assistant" ? message.id : undefined;
    } catch (error) {
      console.error("[Mentor Code Extension] assistant message persistence failed", error);
      await this.post({
        type: "conversationPersistenceFailed",
        message: this.genericFailureMessage()
      });
      return undefined;
    }
  }

  private async persistApprovedAction(input: {
    readonly conversationId?: string;
    readonly messageId: string;
    readonly action: PersistedConversationAction;
  }): Promise<void> {
    try {
      await this.conversations.markMessageActionApproved(input);
    } catch (error) {
      console.error("[Mentor Code Extension] approval state persistence failed after local action", error);
      await this.post({
        type: "conversationPersistenceFailed",
        message: this.genericFailureMessage()
      });
    }
  }

  private workspaceKeySource(): string {
    const workspaceFile = vscode.workspace.workspaceFile?.toString() ?? "";
    const folders = vscode.workspace.workspaceFolders
      ?.map((folder) => folder.uri.toString())
      .sort()
      .join("\n") ?? "";
    return [workspaceFile, folders].filter(Boolean).join("\n") || "empty-workspace";
  }

  private workspaceFolder(): vscode.WorkspaceFolder {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("ワークスペースが開かれていません。");
    }

    return workspaceFolder;
  }

  private renderHtml(webview: vscode.Webview): string {
    const distIndex = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "index.html");
    let html: string;

    try {
      html = readFileSync(distIndex.fsPath, "utf-8");
    } catch {
      html = this.fallbackHtml();
    }

    const nonce = this.createNonce();
    const webviewRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    html = html.replace(/(?:href|src)="\.\/assets\/([^"]+)"/g, (match, asset) => {
      const attribute = match.startsWith("href") ? "href" : "src";
      const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "assets", asset));
      return `${attribute}="${resourceUri.toString()}"`;
    });
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);
    html = html.replace(
      "</head>",
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; font-src ${webview.cspSource} data:;"></head>`
    );

    return html;
  }

  private fallbackHtml(): string {
    return [
      "<!doctype html>",
      "<html lang=\"ja\">",
      "<head><meta charset=\"UTF-8\"><title>Mentor Code</title></head>",
      "<body>",
      "<h1>Mentor Code</h1>",
      "<p>Webview成果物が未生成です。作業ディレクトリ C:\\work\\MentorCode で npm run build を実行してください。</p>",
      "</body>",
      "</html>"
    ].join("");
  }

  private createNonce(): string {
    const source = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let index = 0; index < 32; index += 1) {
      nonce += source[Math.floor(Math.random() * source.length)];
    }
    return nonce;
  }
}
