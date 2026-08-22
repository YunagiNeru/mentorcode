import { HintProfileResolver } from "../../domain/mentor/hintProfile";
import { ApplyPatchParser } from "../../domain/agent/applyPatch";
import { CommandMutationGuard } from "../../domain/commands/commandMutationGuard";
import type { McpToolContext } from "../../domain/mcp";
import type {
  ContextPackage,
  MentorCommandToolCall,
  MentorMcpToolCall,
  MentorToolCall,
  MentorPatchToolCall,
  MentorRequest,
  MentorResponse
} from "../../domain/types";

export class MentorOutputSafetyError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super("Mentor response failed output safety validation.");
  }
}

export interface MentorToolCallSanitizationResult {
  readonly response: MentorResponse;
  readonly issues: readonly string[];
  readonly discardedPatchToolCall: boolean;
  readonly discardedPatchTargetFiles: readonly string[];
}

export class MentorOutputGuard {
  private readonly hintProfiles = new HintProfileResolver();
  private readonly patchParser = new ApplyPatchParser();
  private readonly commandMutationGuard = new CommandMutationGuard();

  public assertSafe(response: MentorResponse, request: MentorRequest): void {
    const issues = this.validate(response, request);
    if (issues.length > 0) {
      throw new MentorOutputSafetyError(issues);
    }
  }

  public validate(response: MentorResponse, request: MentorRequest): readonly string[] {
    const issues: string[] = [];
    const profile = this.hintProfiles.resolve(request.hintLevel);

    if (response.toolCalls && response.toolCalls.length > 0 && !profile.allowsImplementationActions) {
      issues.push("現在のヒント段階では toolCalls を返せません。");
    }

    this.validateUserFacingText(response, issues);

    for (const [index, toolCall] of (response.toolCalls ?? []).entries()) {
      if (toolCall.type === "apply_patch") {
        this.validatePatchToolCall(index, toolCall, issues);
      } else if (toolCall.type === "run_command") {
        this.validateCommandToolCall(index, toolCall, issues);
      } else if (toolCall.type === "mcp_tool") {
        this.validateMcpToolCall(index, toolCall, issues);
      }
    }

    return issues;
  }

  public sanitizeToolCalls(response: MentorResponse, request: MentorRequest): MentorToolCallSanitizationResult {
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        response,
        issues: [],
        discardedPatchToolCall: false,
        discardedPatchTargetFiles: []
      };
    }

    const profile = this.hintProfiles.resolve(request.hintLevel);
    if (!profile.allowsImplementationActions) {
      return {
        response: this.withSanitizedToolCalls(response, [], [
          "現在のヒント段階ではツール提案を表示できないため破棄しました。"
        ]),
        issues: ["現在のヒント段階では toolCalls を返せません。"],
        discardedPatchToolCall: response.toolCalls.some((toolCall) => toolCall.type === "apply_patch"),
        discardedPatchTargetFiles: this.patchTargetFiles(response.toolCalls)
      };
    }

    const safeToolCalls: MentorToolCall[] = [];
    const warnings: string[] = [];
    const issues: string[] = [];
    const discardedPatchTargetFiles = new Set<string>();
    let discardedPatchToolCall = false;

    for (const [index, toolCall] of response.toolCalls.entries()) {
      const toolIssues = this.validateToolCall(index, toolCall);
      if (toolIssues.length === 0) {
        safeToolCalls.push(toolCall);
        continue;
      }

      issues.push(...toolIssues);
      if (toolCall.type === "apply_patch") {
        discardedPatchToolCall = true;
        for (const path of this.patchTargetFiles([toolCall])) {
          discardedPatchTargetFiles.add(path);
        }
      }
      this.appendWarning(warnings, "一部のツール提案は安全検証を通過しなかったため破棄しました。");
    }

    const sanitizedToolCalls = discardedPatchToolCall ? [] : safeToolCalls;
    return {
      response: warnings.length > 0
        ? this.withSanitizedToolCalls(response, sanitizedToolCalls, warnings)
        : response,
      issues,
      discardedPatchToolCall,
      discardedPatchTargetFiles: [...discardedPatchTargetFiles]
    };
  }

  public validateToolPlan(
    response: MentorResponse,
    contextPackage: ContextPackage,
    mcpContext?: McpToolContext
  ): readonly string[] {
    const issues: string[] = [];
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return issues;
    }

    const availablePaths = this.availableProjectPaths(response, contextPackage);
    if (response.toolCalls.filter((toolCall) => toolCall.type === "mcp_tool").length > 1) {
      issues.push("1回の応答で提案できるmcp_toolは1件までです。");
    }
    for (const [index, toolCall] of response.toolCalls.entries()) {
      if (toolCall.type === "mcp_tool") {
        const allowed = mcpContext?.tools.some((candidate) => (
          candidate.serverId === toolCall.serverId && candidate.name === toolCall.toolName
        ));
        if (!allowed) {
          issues.push(`toolCalls[${index}] は送信済みMCP Tool候補に一致しません。`);
        }
        continue;
      }
      if (toolCall.type !== "run_command") {
        continue;
      }

      const requirement = this.projectCommandRequirement(toolCall.command);
      if (!requirement) {
        continue;
      }

      if (this.hasAnyRequiredPath(availablePaths, requirement.fileNames)) {
        continue;
      }

      issues.push(
        `toolCalls[${index}].command は ${requirement.label} の構成ファイルが files[] に無く、同じ応答内の有効な apply_patch でも作成されていません。先に apply_patch で必要ファイルを作成してください。`
      );
    }

    return issues;
  }

  private validateUserFacingText(response: MentorResponse, issues: string[]): void {
    for (const [sectionIndex, section] of response.sections.entries()) {
      for (const [itemIndex, item] of section.items.entries()) {
        if (/^\s*[{[]/.test(item) && /"(?:sections|toolCalls|editProposal|commandProposal)"/.test(item)) {
          issues.push(`sections[${sectionIndex}].items[${itemIndex}] に構造化JSONの生断片があります。`);
        }
      }
    }
  }

  private validateToolCall(index: number, toolCall: MentorToolCall): readonly string[] {
    const issues: string[] = [];
    if (toolCall.type === "apply_patch") {
      this.validatePatchToolCall(index, toolCall, issues);
    } else if (toolCall.type === "run_command") {
      this.validateCommandToolCall(index, toolCall, issues);
    } else if (toolCall.type === "mcp_tool") {
      this.validateMcpToolCall(index, toolCall, issues);
    }
    return issues;
  }

  private availableProjectPaths(response: MentorResponse, contextPackage: ContextPackage): readonly string[] {
    const paths = new Set<string>();
    for (const file of contextPackage.files) {
      paths.add(this.normalizePath(file.path));
    }

    for (const toolCall of response.toolCalls ?? []) {
      if (toolCall.type !== "apply_patch") {
        continue;
      }

      try {
        for (const action of this.patchParser.parse(toolCall.patch).actions) {
          paths.add(this.normalizePath(action.path));
          if (action.type === "update" && action.moveTo) {
            paths.add(this.normalizePath(action.moveTo));
          }
        }
      } catch {
        // Invalid patches are handled by schema diagnostics before plan validation.
      }
    }

    return [...paths];
  }

  private projectCommandRequirement(command: string): { readonly label: string; readonly fileNames: readonly string[] } | undefined {
    const normalized = command.trim().toLowerCase();
    if (this.isVersionOnlyCommand(normalized)) {
      return undefined;
    }

    if (/(^|[;&|()\s])(?:\.\/)?(?:mvnw|mvn)(?:\s|$)/.test(normalized)) {
      return {
        label: "Maven",
        fileNames: ["pom.xml"]
      };
    }

    if (/(^|[;&|()\s])(?:\.\/)?(?:gradlew|gradle)(?:\s|$)/.test(normalized)) {
      return {
        label: "Gradle",
        fileNames: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]
      };
    }

    if (/(^|[;&|()\s])(?:npm|pnpm|yarn|bun)\s+(?:install|run|test|build|start)\b/.test(normalized)) {
      return {
        label: "Node.js",
        fileNames: ["package.json"]
      };
    }

    if (/(^|[;&|()\s])dotnet\s+(?:build|test|run|restore)\b/.test(normalized)) {
      return {
        label: ".NET",
        fileNames: [".sln", ".csproj"]
      };
    }

    return undefined;
  }

  private isVersionOnlyCommand(command: string): boolean {
    return /\b(?:--version|-version|-v)\b/.test(command);
  }

  private hasAnyRequiredPath(paths: readonly string[], fileNames: readonly string[]): boolean {
    return paths.some((path) => fileNames.some((fileName) => path === fileName || path.endsWith(`/${fileName}`)));
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
  }

  private withSanitizedToolCalls(
    response: MentorResponse,
    toolCalls: readonly MentorToolCall[],
    warnings: readonly string[]
  ): MentorResponse {
    const sanitized = {
      ...response,
      policyWarnings: [
        ...response.policyWarnings,
        ...warnings
      ]
    };

    if (toolCalls.length > 0) {
      return {
        ...sanitized,
        toolCalls
      };
    }

    return {
      title: sanitized.title,
      sections: sanitized.sections,
      policyWarnings: sanitized.policyWarnings
    };
  }

  private appendWarning(warnings: string[], message: string): void {
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
  }

  private patchTargetFiles(toolCalls: readonly MentorToolCall[]): readonly string[] {
    const paths = new Set<string>();
    for (const toolCall of toolCalls) {
      if (toolCall.type !== "apply_patch") {
        continue;
      }

      try {
        for (const action of this.patchParser.parse(toolCall.patch).actions) {
          paths.add(action.path);
          if (action.type === "update" && action.moveTo) {
            paths.add(action.moveTo);
          }
        }
      } catch {
        // Invalid patches are already reported by validation; target recovery is best-effort.
      }
    }

    return [...paths];
  }

  private validatePatchToolCall(index: number, toolCall: MentorPatchToolCall, issues: string[]): void {
    const label = `toolCalls[${index}]`;
    this.validateNoMaskedPlaceholder(`${label}.intent`, toolCall.intent, issues);
    this.validateGeneratedFileContent(`${label}.patch`, toolCall.patch, issues);
    for (const [explanationIndex, item] of (toolCall.fileExplanations ?? []).entries()) {
      this.validateNoMaskedPlaceholder(
        `${label}.fileExplanations[${explanationIndex}].explanation`,
        item.explanation,
        issues
      );
    }
    try {
      const parsed = this.patchParser.parse(toolCall.patch);
      if (parsed.actions.length === 0 || parsed.actions.length > 24) {
        issues.push(`${label}.patch は1件以上24件以下の操作にしてください。`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      issues.push(`${label}.patch は apply_patch として解析できません。${detail}`);
    }
  }

  private validateCommandToolCall(index: number, toolCall: MentorCommandToolCall, issues: string[]): void {
    const label = `toolCalls[${index}]`;
    this.validateNoMaskedPlaceholder(`${label}.command`, toolCall.command, issues);
    this.validateNoMaskedPlaceholder(`${label}.meaning`, toolCall.meaning, issues);
    this.validateNoMaskedPlaceholder(`${label}.expectedResult`, toolCall.expectedResult, issues);
    const mutationFindings = this.commandMutationGuard.findings(toolCall.command, toolCall.shell);
    for (const finding of mutationFindings) {
      issues.push(`${label}.command はファイル書き換え用途に見えるため禁止です。${finding.reason} 編集は apply_patch を使ってください。`);
    }
  }

  private validateMcpToolCall(index: number, toolCall: MentorMcpToolCall, issues: string[]): void {
    const label = `toolCalls[${index}]`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(toolCall.serverId)) {
      issues.push(`${label}.serverId の形式が不正です。`);
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(toolCall.toolName)) {
      issues.push(`${label}.toolName の形式が不正です。`);
    }
    if (Buffer.byteLength(JSON.stringify(toolCall.arguments), "utf8") > 32 * 1024) {
      issues.push(`${label}.arguments は32KB以内にしてください。`);
    }
    this.validateNoMaskedPlaceholder(`${label}.arguments`, JSON.stringify(toolCall.arguments), issues);
    this.validateNoMaskedPlaceholder(`${label}.intent`, toolCall.intent, issues);
    this.validateNoMaskedPlaceholder(`${label}.expectedResult`, toolCall.expectedResult, issues);
  }

  private validateGeneratedFileContent(label: string, content: string, issues: string[]): void {
    this.validateNoMaskedPlaceholder(label, content, issues);
  }

  private validateNoMaskedPlaceholder(label: string, value: string, issues: string[]): void {
    if (/__[A-Z0-9_]+_\d+__/.test(value)) {
      issues.push(`${label} にマスク済みプレースホルダを書き戻す内容があります。`);
    }
  }
}
