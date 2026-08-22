export type Severity = "low" | "medium" | "high" | "critical";

export type GuardAction = "allow" | "warn" | "mask" | "block";

export type MentorContextSource = "explicit_reference" | "task_discovery" | "workspace_scan";

export interface FileCandidate {
  readonly path: string;
  readonly content: string;
  readonly sizeBytes?: number;
  readonly contextSource?: MentorContextSource;
  readonly sourceSizeBytes?: number;
  readonly includedSizeBytes?: number;
  readonly contentComplete?: boolean;
}

export interface PathDecision {
  readonly path: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly severity: Severity;
}

export interface DetectionFinding {
  readonly id: string;
  readonly detector: string;
  readonly type: string;
  readonly severity: Severity;
  readonly action: GuardAction;
  readonly start: number;
  readonly end: number;
  readonly placeholder?: string;
  readonly reason: string;
}

export interface MaskingEvent {
  readonly detector: string;
  readonly type: string;
  readonly severity: Severity;
  readonly action: GuardAction;
  readonly placeholder?: string;
}

export type LocalLlmReviewStatus = "not_run" | "completed" | "failed";
export type LocalLlmGuidanceSource = "bonsai_generated" | "safety_template" | "mixed";

export interface LocalLlmReview {
  readonly status: LocalLlmReviewStatus;
  readonly model: string;
  readonly location: "vscode_extension_host";
  readonly verdict?: string;
  readonly confidence?: number;
  readonly detectedTypes: readonly string[];
  readonly educationSummary: string;
  readonly riskPoints: readonly string[];
  readonly recommendedAction: string;
  readonly guidanceSource?: LocalLlmGuidanceSource;
  readonly guidanceSourceReason?: string;
  readonly failureReason?: string;
}

export interface LocalLlmProjectReview {
  readonly status: LocalLlmReviewStatus;
  readonly model: string;
  readonly location: "vscode_extension_host";
  readonly targetFiles: number;
  readonly includedFiles: number;
  readonly blockedFiles: number;
  readonly reviewMarkdown: string;
  readonly guidanceSource: "bonsai_generated" | "safety_template";
  readonly failureReason?: string;
}

export interface FileGuardResult {
  readonly path: string;
  readonly blocked: boolean;
  readonly excluded: boolean;
  readonly excludeReason?: string;
  readonly maskedContent?: string;
  readonly findings: readonly DetectionFinding[];
  readonly maskingEvents: readonly MaskingEvent[];
  readonly localLlmReview?: LocalLlmReview;
}

export interface ContextPackage {
  readonly files: readonly {
    readonly path: string;
    readonly maskedContent: string;
    readonly localLlmReview?: LocalLlmReview;
    readonly contextSource?: MentorContextSource;
    readonly sourceSizeBytes?: number;
    readonly includedSizeBytes?: number;
    readonly contentComplete?: boolean;
  }[];
  readonly blockedFiles: readonly {
    readonly path: string;
    readonly reason: string;
    readonly localLlmReview?: LocalLlmReview;
    readonly contextSource?: MentorContextSource;
    readonly sourceSizeBytes?: number;
    readonly includedSizeBytes?: number;
    readonly contentComplete?: boolean;
  }[];
  readonly summary: GuardSummary;
  readonly projectReview?: LocalLlmProjectReview;
}

export interface GuardSummary {
  readonly scannedFiles: number;
  readonly includedFiles: number;
  readonly blockedFiles: number;
  readonly maskedFindings: number;
  readonly warningFindings: number;
  readonly criticalFindings: number;
}

export interface WorkspaceMap {
  readonly totalFiles: number;
  readonly includedFiles: number;
  readonly excludedFiles: number;
  readonly languageHints: readonly string[];
  readonly topLevelEntries: readonly string[];
}

export type MentorHintLevel = "low" | "medium" | "high" | "very_high";

export interface MentorRequest {
  readonly task: string;
  readonly workspaceMap?: WorkspaceMap;
  readonly guardSummary?: GuardSummary;
  readonly hintLevel?: MentorHintLevel | number;
}

export type ConversationContextMessageRole = "user" | "assistant";

export interface ConversationContextMessage {
  readonly role: ConversationContextMessageRole;
  readonly createdAt: string;
  readonly text: string;
  readonly approvedActions?: readonly string[];
}

export type MentorToolActionKind = "applyPatch" | "runCommand" | "mcpTool";

export interface ConversationContextAction {
  readonly messageId: string;
  readonly kind: MentorToolActionKind;
  readonly status: "approved";
  readonly summary: string;
  readonly targets: readonly string[];
}

export interface ConversationContextCommandResult {
  readonly shell: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly safetyNotice: string;
}

export interface EditApplicationResult {
  readonly assistantMessageId?: string;
  readonly appliedFiles: readonly string[];
  readonly operationCount: number;
  readonly message: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly delta?: AppliedPatchDelta;
}

export interface ConversationContextEditResult extends EditApplicationResult {}

export type MentorContinuationKind = "editApplied" | "commandCompleted" | "patchApplyFailed";

export interface MentorContinuation {
  readonly kind: MentorContinuationKind;
  readonly sourceAssistantMessageId?: string;
}

export interface ConversationContextAssistantActionSummary {
  readonly messageId: string;
  readonly title: string;
  readonly editIntent?: string;
  readonly editTargets: readonly string[];
  readonly command?: string;
  readonly commandExpectedResult?: string;
  readonly mcpTool?: string;
  readonly mcpExpectedResult?: string;
}

export interface ConversationCompactionState {
  readonly strategy: "deterministic_summary";
  readonly totalMessages: number;
  readonly compactedMessages: number;
  readonly recentMessageLimit: number;
}

export interface ConversationContext {
  readonly conversationId: string;
  readonly title: string;
  readonly originalGoal?: string;
  readonly compactedSummary?: string;
  readonly compaction?: ConversationCompactionState;
  readonly recentMessages: readonly ConversationContextMessage[];
  readonly approvedActions: readonly ConversationContextAction[];
  readonly lastAssistantActionSummary?: ConversationContextAssistantActionSummary;
  readonly lastEditResult?: ConversationContextEditResult;
  readonly lastCommandResult?: ConversationContextCommandResult;
}

export interface MentorFileEdit {
  readonly path: string;
  readonly originalText: string;
  readonly replacementText: string;
  readonly explanation: string;
}

export type MentorWorkspaceOperation =
  | {
    readonly type: "createFile";
    readonly path: string;
    readonly content: string;
    readonly explanation: string;
  }
  | {
    readonly type: "createDirectory";
    readonly path: string;
    readonly explanation: string;
  }
  | {
    readonly type: "replaceInFile";
    readonly path: string;
    readonly originalText: string;
    readonly replacementText: string;
    readonly explanation: string;
  }
  | {
    readonly type: "renamePath";
    readonly path: string;
    readonly newPath: string;
    readonly explanation: string;
  }
  | {
    readonly type: "deletePath";
    readonly path: string;
    readonly recursive: boolean;
    readonly explanation: string;
  };

export interface MentorPatchPreview {
  readonly mode: "workspace";
  readonly intent: string;
  readonly operations: readonly MentorWorkspaceOperation[];
}

export type CommandShell = "powershell" | "cmd" | "bash";

export interface MentorPatchFileExplanation {
  readonly path: string;
  readonly explanation: string;
}

export interface MentorPatchToolCall {
  readonly type: "apply_patch";
  readonly intent: string;
  readonly patch: string;
  readonly fileExplanations?: readonly MentorPatchFileExplanation[];
}

export interface MentorCommandToolCall {
  readonly type: "run_command";
  readonly shell: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly meaning: string;
  readonly expectedResult: string;
}

export interface MentorMcpToolCall {
  readonly type: "mcp_tool";
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly intent: string;
  readonly expectedResult: string;
}

export type MentorToolCall = MentorPatchToolCall | MentorCommandToolCall | MentorMcpToolCall;

export interface ManualImplementationInstruction {
  readonly required: true;
  readonly reason: string;
  readonly targetFiles: readonly string[];
}

export interface CommandExecutionResult {
  readonly shell: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly safetySummary: GuardSummary;
  readonly safetyNotice: string;
}

export type CommandExecutionOutputStream = "stdout" | "stderr";

export interface CommandExecutionOutputSnapshot {
  readonly shell: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly activeStream: CommandExecutionOutputStream;
  readonly stdout: string;
  readonly stderr: string;
  readonly safetySummary: GuardSummary;
  readonly safetyNotice: string;
  readonly truncated: boolean;
}

export interface MentorResponse {
  readonly title: string;
  readonly sections: readonly {
    readonly heading: string;
    readonly items: readonly string[];
  }[];
  readonly policyWarnings: readonly string[];
  readonly toolCalls?: readonly MentorToolCall[];
  readonly manualImplementation?: ManualImplementationInstruction;
}

export type CommandRisk = "low" | "medium" | "high" | "critical";

export interface CommandApprovalCard {
  readonly shell?: CommandShell;
  readonly command: string;
  readonly workingDirectory: string;
  readonly risk: CommandRisk;
  readonly meaning: string;
  readonly expectedResult: string;
  readonly hazards: readonly string[];
  readonly rollback: readonly string[];
  readonly copyOnly: boolean;
  readonly allowedToExecute: boolean;
}
import type { AppliedPatchDelta } from "./agent/applyPatch";
