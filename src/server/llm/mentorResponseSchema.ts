import type {
  CommandShell,
  MentorResponse,
  MentorCommandToolCall,
  MentorMcpToolCall,
  MentorPatchFileExplanation,
  ManualImplementationInstruction,
  MentorPatchToolCall,
  MentorToolCall
} from "../../domain/types";
import { ApplyPatchParser } from "../../domain/agent/applyPatch";

interface ToolCallNormalizationResult {
  readonly toolCalls?: readonly MentorToolCall[];
  readonly warnings: readonly string[];
  readonly repairIssues: readonly string[];
}

interface ToolCallNormalizationItem {
  readonly toolCall?: MentorToolCall;
  readonly repairIssue?: string;
}

interface MentorResponseNormalizationResult {
  readonly value: unknown;
  readonly repairIssues: readonly string[];
}

export interface MentorResponseParseResult {
  readonly response: MentorResponse;
  readonly repairIssues: readonly string[];
}

export class MentorResponseSchema {
  private readonly patchParser = new ApplyPatchParser();

  public parse(text: string, source: string): MentorResponse {
    try {
      return this.parseStrict(text, source);
    } catch {
      return this.fallbackResponse(text);
    }
  }

  public parseStrict(text: string, source: string): MentorResponse {
    return this.parseStrictWithDiagnostics(text, source).response;
  }

  public parseStrictWithDiagnostics(text: string, source: string): MentorResponseParseResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.extractJsonText(text));
    } catch {
      throw new MentorResponseSchemaError(source, [
        `${source}応答はJSONとして解析できませんでした。JSONだけを返す必要があります。`
      ]);
    }

    const normalized = this.normalizeMentorResponse(parsed);
    const errors = this.validateMentorResponse(normalized.value);
    if (errors.length > 0) {
      throw new MentorResponseSchemaError(source, errors);
    }

    return {
      response: normalized.value as MentorResponse,
      repairIssues: normalized.repairIssues
    };
  }

  private normalizeMentorResponse(value: unknown): MentorResponseNormalizationResult {
    if (!this.isRecord(value)) {
      return {
        value,
        repairIssues: []
      };
    }

    const normalized: Record<string, unknown> = { ...value };

    if (typeof normalized.title !== "string" || normalized.title.trim().length === 0) {
      normalized.title = "メンター応答";
    }

    const policyWarnings = this.normalizePolicyWarnings(normalized.policyWarnings);
    normalized.policyWarnings = policyWarnings;

    normalized.sections = this.normalizeSections(normalized.sections);
    const manualImplementation = this.normalizeManualImplementation(normalized.manualImplementation);
    if (manualImplementation) {
      normalized.manualImplementation = manualImplementation;
    } else {
      delete normalized.manualImplementation;
    }

    const toolCalls = this.normalizeToolCalls(normalized.toolCalls);
    if (toolCalls.toolCalls === undefined) {
      delete normalized.toolCalls;
    } else {
      normalized.toolCalls = toolCalls.toolCalls;
    }

    if (toolCalls.warnings.length > 0) {
      normalized.policyWarnings = [
        ...policyWarnings,
        ...toolCalls.warnings
      ];
    }

    return {
      value: normalized,
      repairIssues: toolCalls.repairIssues
    };
  }

  private extractJsonText(text: string): string {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    return trimmed;
  }

  private normalizeSections(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((section) => this.normalizeSection(section));
    }

    if (typeof value === "string") {
      return [
        {
          heading: "回答",
          items: [value]
        }
      ];
    }

    if (this.isRecord(value)) {
      return Object.entries(value).map(([heading, items]) => ({
        heading,
        items: this.normalizeSectionItems(items)
      }));
    }

    return value;
  }

  private normalizeSection(value: unknown): unknown {
    if (typeof value === "string") {
      return {
        heading: "回答",
        items: [value]
      };
    }

    if (!this.isRecord(value)) {
      return value;
    }

    return {
      ...value,
      heading: typeof value.heading === "string" && value.heading.trim().length > 0 ? value.heading : "回答",
      items: this.normalizeSectionItems(value.items)
    };
  }

  private normalizeSectionItems(value: unknown): unknown {
    if (value === undefined || value === null) {
      return [];
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => this.normalizeSectionItem(item))
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }

    const item = this.normalizeSectionItem(value);
    return typeof item === "string" && item.trim().length > 0 ? [item] : value;
  }

  private normalizeSectionItem(value: unknown): unknown {
    if (typeof value === "string") {
      return value;
    }

    if (this.isRecord(value)) {
      for (const key of ["text", "content", "message", "description", "value"]) {
        if (typeof value[key] === "string") {
          return value[key];
        }
      }
    }

    return value;
  }

  private normalizePolicyWarnings(value: unknown): readonly string[] {
    if (value === undefined || value === null) {
      return [];
    }

    if (typeof value === "string") {
      return value.trim().length > 0 ? [value] : [];
    }

    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .filter((item) => item.trim().length > 0);
    }

    return [];
  }

  private normalizeManualImplementation(value: unknown): ManualImplementationInstruction | undefined {
    if (!this.isRecord(value) || value.required !== true) {
      return undefined;
    }

    const targetFiles = Array.isArray(value.targetFiles)
      ? value.targetFiles
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 16)
      : [];

    return {
      required: true,
      reason: typeof value.reason === "string" && value.reason.trim().length > 0
        ? value.reason
        : "安全検証で自動編集できないため、ユーザーによる手動実装が必要です。",
      targetFiles
    };
  }

  private normalizeToolCalls(value: unknown): ToolCallNormalizationResult {
    if (value === undefined || value === null) {
      return { warnings: [], repairIssues: [] };
    }

    if (this.isRecord(value) && Object.keys(value).length === 0) {
      return { warnings: [], repairIssues: [] };
    }

    const candidates = Array.isArray(value)
      ? value
      : this.isRecord(value)
        ? [value]
        : undefined;

    if (!candidates) {
      return {
        warnings: ["一部のツール提案は形式が不正だったため破棄しました。"],
        repairIssues: ["toolCalls は配列または単一の apply_patch/run_command/mcp_tool オブジェクトで返してください。"]
      };
    }

    const warnings: string[] = [];
    const repairIssues: string[] = [];
    if (candidates.length > 4) {
      this.appendWarning(warnings, "ツール提案が多すぎるため、先頭4件だけを対象にしました。");
    }

    const normalized: MentorToolCall[] = [];
    candidates.slice(0, 4).forEach((candidate, index) => {
      const result = this.normalizeToolCall(candidate, index);
      if (!result.toolCall) {
        this.appendWarning(warnings, "一部のツール提案は形式が不正だったため破棄しました。");
        if (result.repairIssue) {
          repairIssues.push(result.repairIssue);
        }
        return;
      }

      normalized.push(result.toolCall);
      if (result.repairIssue) {
        repairIssues.push(result.repairIssue);
      }
    });

    if (normalized.length === 0) {
      return { warnings, repairIssues };
    }

    return {
      toolCalls: normalized,
      warnings,
      repairIssues
    };
  }

  private appendWarning(warnings: string[], message: string): void {
    if (!warnings.includes(message)) {
      warnings.push(message);
    }
  }

  private normalizeToolCall(value: unknown, index: number): ToolCallNormalizationItem {
    if (!this.isRecord(value) || typeof value.type !== "string") {
      return {};
    }

    if (value.type === "apply_patch") {
      return this.normalizePatchToolCall(value, index);
    }

    if (value.type === "run_command") {
      return this.normalizeRunCommandToolCall(value, index);
    }

    if (value.type === "mcp_tool") {
      return this.normalizeMcpToolCall(value, index);
    }

    return {
      repairIssue: `toolCalls[${index}].type は apply_patch、run_command、mcp_tool のいずれかにしてください。`
    };
  }

  private normalizePatchToolCall(value: Record<string, unknown>, index: number): ToolCallNormalizationItem {
    if (typeof value.patch !== "string" || value.patch.trim().length === 0) {
      return {
        repairIssue: `toolCalls[${index}].patch は空でない文字列にしてください。`
      };
    }

    let targetPaths: readonly string[];
    try {
      targetPaths = this.patchParser.parse(value.patch).actions.map((action) => action.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        repairIssue: `toolCalls[${index}].patch は apply_patch として解析できません。${detail}`
      };
    }

    const fileExplanations = this.normalizePatchFileExplanations(value.fileExplanations, targetPaths);
    return {
      toolCall: {
        type: "apply_patch",
        intent: typeof value.intent === "string" && value.intent.trim().length > 0
          ? value.intent
          : "LLMが提案した apply_patch 編集",
        patch: value.patch,
        ...(fileExplanations.values.length > 0 ? { fileExplanations: fileExplanations.values } : {})
      },
      ...(fileExplanations.repairIssue
        ? { repairIssue: `toolCalls[${index}].${fileExplanations.repairIssue}` }
        : {})
    };
  }

  private normalizePatchFileExplanations(
    value: unknown,
    targetPaths: readonly string[]
  ): {
    readonly values: readonly MentorPatchFileExplanation[];
    readonly repairIssue?: string;
  } {
    const expectedPaths = [...new Map(targetPaths.map((path) => [this.normalizePath(path), path])).values()];
    const candidates = Array.isArray(value)
      ? value.flatMap((item): MentorPatchFileExplanation[] => {
        if (
          !this.isRecord(item) ||
          typeof item.path !== "string" ||
          item.path.trim().length === 0 ||
          typeof item.explanation !== "string" ||
          item.explanation.trim().length === 0
        ) {
          return [];
        }
        return [{
          path: item.path.trim(),
          explanation: item.explanation.trim()
        }];
      })
      : [];
    const explanationsByPath = new Map(
      candidates.map((item) => [this.normalizePath(item.path), item.explanation])
    );
    const values = expectedPaths.flatMap((path): MentorPatchFileExplanation[] => {
      const explanation = explanationsByPath.get(this.normalizePath(path));
      return explanation ? [{ path, explanation }] : [];
    });
    const missingPaths = expectedPaths.filter((path) => !explanationsByPath.has(this.normalizePath(path)));
    const expectedPathKeys = new Set(expectedPaths.map((path) => this.normalizePath(path)));
    const hasUnknownPaths = candidates.some((item) => !expectedPathKeys.has(this.normalizePath(item.path)));

    if (missingPaths.length === 0 && !hasUnknownPaths) {
      return { values };
    }

    const missing = missingPaths.length > 0 ? `不足パス: ${missingPaths.join(", ")}。` : "";
    const unknown = hasUnknownPaths ? "patch に存在しないパスを含めないでください。" : "";
    return {
      values,
      repairIssue: `fileExplanations は patch 内の各ファイルについて、変更理由・目的・影響を1〜2文で指定してください。${missing}${unknown}`
    };
  }

  private normalizeRunCommandToolCall(value: Record<string, unknown>, index: number): ToolCallNormalizationItem {
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      return {
        repairIssue: `toolCalls[${index}].command は空でない文字列にしてください。`
      };
    }

    const shell = this.normalizeCommandShell(value.shell, value.command);
    if (!shell) {
      return {
        repairIssue: `toolCalls[${index}].shell は powershell, cmd, bash のいずれかにしてください。`
      };
    }

    return {
      toolCall: {
        type: "run_command",
        shell,
        command: value.command,
        workingDirectory: typeof value.workingDirectory === "string" && value.workingDirectory.trim().length > 0
          ? value.workingDirectory
          : ".",
        meaning: typeof value.meaning === "string" && value.meaning.trim().length > 0
          ? value.meaning
          : "LLMが提案したコマンドを実行します。",
        expectedResult: typeof value.expectedResult === "string" && value.expectedResult.trim().length > 0
          ? value.expectedResult
          : "コマンドの標準出力と標準エラーを確認します。"
      }
    };
  }

  private normalizeMcpToolCall(value: Record<string, unknown>, index: number): ToolCallNormalizationItem {
    if (typeof value.serverId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.serverId)) {
      return { repairIssue: `toolCalls[${index}].serverId は候補内の有効なMCPサーバーIDにしてください。` };
    }
    if (typeof value.toolName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.toolName)) {
      return { repairIssue: `toolCalls[${index}].toolName は候補内の有効なMCP Tool名にしてください。` };
    }
    if (!this.isRecord(value.arguments) || Buffer.byteLength(JSON.stringify(value.arguments), "utf8") > 32 * 1024) {
      return { repairIssue: `toolCalls[${index}].arguments は32KB以内のJSONオブジェクトにしてください。` };
    }
    return {
      toolCall: {
        type: "mcp_tool",
        serverId: value.serverId,
        toolName: value.toolName,
        arguments: value.arguments,
        intent: typeof value.intent === "string" && value.intent.trim().length > 0
          ? value.intent.trim()
          : "MCP Toolを実行します。",
        expectedResult: typeof value.expectedResult === "string" && value.expectedResult.trim().length > 0
          ? value.expectedResult.trim()
          : "MCP Toolの結果を確認します。"
      }
    };
  }

  private normalizeCommandShell(value: unknown, command: string): CommandShell | undefined {
    if (typeof value !== "string" || value.trim().length === 0) {
      return this.inferCommandShell(command);
    }

    const normalized = value.trim().replace(/[-_\s.]/g, "").toLowerCase();
    switch (normalized) {
      case "powershell":
      case "powershellexe":
      case "pwsh":
      case "pwshexe":
        return "powershell";
      case "cmd":
      case "cmdexe":
      case "commandprompt":
        return "cmd";
      case "bash":
      case "gitbash":
      case "sh":
        return "bash";
      default:
        return this.inferCommandShell(command);
    }
  }

  private inferCommandShell(command: string): CommandShell {
    if (/\b(setlocal|dir|copy|xcopy|robocopy)\b/i.test(command)) {
      return "cmd";
    }

    if (/\b(grep|sed|awk)\b/.test(command) || command.includes("#!/bin/")) {
      return "bash";
    }

    return "powershell";
  }

  private validateMentorResponse(value: unknown): readonly string[] {
    const errors: string[] = [];
    if (!this.isRecord(value)) {
      return ["root must be an object"];
    }

    if (typeof value.title !== "string") {
      errors.push("title must be a string");
    }

    if (!Array.isArray(value.sections)) {
      errors.push("sections must be an array");
    } else {
      value.sections.forEach((section, index) => {
        if (!this.isRecord(section)) {
          errors.push(`sections[${index}] must be an object`);
          return;
        }
        if (typeof section.heading !== "string") {
          errors.push(`sections[${index}].heading must be a string`);
        }
        if (!Array.isArray(section.items) || !section.items.every((item) => typeof item === "string")) {
          errors.push(`sections[${index}].items must be an array of strings`);
        }
      });
    }

    if (!Array.isArray(value.policyWarnings) || !value.policyWarnings.every((item) => typeof item === "string")) {
      errors.push("policyWarnings must be an array of strings");
    }

    if ("editProposal" in value) {
      errors.push("editProposal is no longer accepted; use toolCalls with type apply_patch");
    }

    if ("commandProposal" in value) {
      errors.push("commandProposal is no longer accepted; use toolCalls with type run_command");
    }

    if ("toolCalls" in value && value.toolCalls !== undefined && !this.isToolCalls(value.toolCalls)) {
      errors.push("toolCalls must be omitted or an array of apply_patch/run_command/mcp_tool tool calls");
    }

    if (
      "manualImplementation" in value &&
      value.manualImplementation !== undefined &&
      !this.isManualImplementation(value.manualImplementation)
    ) {
      errors.push("manualImplementation must be omitted or an object with required=true and targetFiles array");
    }

    return errors;
  }

  private isManualImplementation(value: unknown): value is ManualImplementationInstruction {
    return this.isRecord(value) &&
      value.required === true &&
      typeof value.reason === "string" &&
      Array.isArray(value.targetFiles) &&
      value.targetFiles.every((item) => typeof item === "string");
  }

  private isToolCalls(value: unknown): value is readonly MentorToolCall[] {
    return Array.isArray(value) &&
      value.length <= 4 &&
      value.every((toolCall) => this.isToolCall(toolCall));
  }

  private isToolCall(value: unknown): value is MentorToolCall {
    if (!this.isRecord(value) || typeof value.type !== "string") {
      return false;
    }

    if (value.type === "apply_patch") {
      return this.isPatchToolCall(value);
    }
    if (value.type === "run_command") {
      return this.isRunCommandToolCall(value);
    }
    if (value.type === "mcp_tool") {
      return this.isMcpToolCall(value);
    }
    return false;
  }

  private isPatchToolCall(value: unknown): value is MentorPatchToolCall {
    if (!this.isRecord(value)) {
      return false;
    }

    if (
      value.type !== "apply_patch" ||
      typeof value.intent !== "string" ||
      typeof value.patch !== "string" ||
      (value.fileExplanations !== undefined && !this.isPatchFileExplanations(value.fileExplanations))
    ) {
      return false;
    }

    try {
      this.patchParser.parse(value.patch);
      return true;
    } catch {
      return false;
    }
  }

  private isPatchFileExplanations(value: unknown): value is readonly MentorPatchFileExplanation[] {
    return Array.isArray(value) && value.every((item) =>
      this.isRecord(item) &&
      typeof item.path === "string" &&
      typeof item.explanation === "string"
    );
  }

  private isRunCommandToolCall(value: unknown): value is MentorCommandToolCall {
    if (!this.isRecord(value)) {
      return false;
    }

    return (
      value.type === "run_command" &&
      this.isCommandShell(value.shell) &&
      typeof value.command === "string" &&
      typeof value.workingDirectory === "string" &&
      typeof value.meaning === "string" &&
      typeof value.expectedResult === "string"
    );
  }

  private isCommandShell(value: unknown): value is CommandShell {
    return value === "powershell" || value === "cmd" || value === "bash";
  }

  private isMcpToolCall(value: unknown): value is MentorMcpToolCall {
    return this.isRecord(value) &&
      value.type === "mcp_tool" &&
      typeof value.serverId === "string" &&
      typeof value.toolName === "string" &&
      this.isRecord(value.arguments) &&
      typeof value.intent === "string" &&
      typeof value.expectedResult === "string";
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
  }

  private fallbackResponse(text: string): MentorResponse {
    return {
      title: "メンター応答",
      sections: [
        {
          heading: "回答",
          items: this.fallbackItems(text)
        }
      ],
      policyWarnings: []
    };
  }

  private fallbackItems(text: string): readonly string[] {
    const normalized = text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (normalized.length === 0) {
      return ["LLMから空の応答が返されました。"];
    }

    return normalized.slice(0, 40);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }
}

export class MentorResponseSchemaError extends Error {
  public constructor(
    public readonly source: string,
    public readonly issues: readonly string[]
  ) {
    super(`${source} mentor response schema validation failed.`);
  }
}
