import { createHash } from "node:crypto";
import type { ContextPackage, FileGuardResult, MaskingEvent, MentorRequest } from "../types";
import { PrivacyGuard } from "./privacyGuard";
import { MentorRequestGuard, type MentorRequestGuardDecision } from "./mentorRequestGuard";

export interface SendTimeQuickAuditOptions {
  readonly maxTargetFiles?: number;
  readonly maxTargetBytes?: number;
}

export interface SendTimeQuickAuditRunOptions {
  readonly skipTargetAuditKeys?: ReadonlySet<string>;
}

export interface SendTimeQuickAuditDecision {
  readonly accepted: boolean;
  readonly request: MentorRequest;
  readonly reason: string;
  readonly targetPaths: readonly string[];
  readonly targetAuditKeys: readonly string[];
  readonly skippedTargetAuditKeys: readonly string[];
  readonly requestDecision: MentorRequestGuardDecision;
  readonly contextResults: readonly FileGuardResult[];
  readonly targetResults: readonly FileGuardResult[];
}

interface ContextFile {
  readonly path: string;
  readonly maskedContent: string;
}

interface TargetFile {
  readonly file: ContextFile;
  readonly maskingEvents: readonly MaskingEvent[];
  readonly auditKey: string;
}

export class SendTimeQuickAudit {
  private readonly requestGuard: MentorRequestGuard;
  private readonly contextGuard = new PrivacyGuard();
  private readonly maxTargetFiles: number;
  private readonly maxTargetBytes: number;

  public constructor(
    private readonly semanticGuard: PrivacyGuard,
    options: SendTimeQuickAuditOptions = {}
  ) {
    this.requestGuard = new MentorRequestGuard(semanticGuard);
    this.maxTargetFiles = options.maxTargetFiles ?? 5;
    this.maxTargetBytes = options.maxTargetBytes ?? 32_000;
  }

  public async audit(
    request: MentorRequest,
    contextPackage: ContextPackage,
    runOptions: SendTimeQuickAuditRunOptions = {}
  ): Promise<SendTimeQuickAuditDecision> {
    const requestDecision = await this.requestGuard.sanitize(request);
    if (!requestDecision.accepted) {
      return this.rejected(
        request,
        requestDecision,
        [],
        [],
        [],
        `ユーザープロンプトのローカル検閲で停止しました。${requestDecision.reason}`
      );
    }

    const contextResults = this.verifyContextPackage(contextPackage);
    const unsafeContext = contextResults.find((result) => {
      if (result.blocked || result.excluded) {
        return true;
      }

      return result.findings.some((finding) => finding.action === "mask" || finding.action === "block");
    });
    if (unsafeContext) {
      return this.rejected(
        requestDecision.request,
        requestDecision,
        [],
        contextResults,
        [],
        `承認済みContextPackageの送信直前検査で未マスク機密候補を検出しました。対象: ${unsafeContext.path}`
      );
    }

    const targetFiles = this.selectTargetFiles(requestDecision.request, contextPackage.files)
      .map((file): TargetFile => {
        const maskingEvents = this.maskingEventsFromPlaceholders(file.maskedContent);
        return {
          file,
          maskingEvents,
          auditKey: this.targetAuditKey(file, maskingEvents)
        };
      })
      .filter((target) => target.maskingEvents.length > 0);
    const targetFilesForAudit = targetFiles.filter((target) => !runOptions.skipTargetAuditKeys?.has(target.auditKey));
    const skippedTargetAuditKeys = targetFiles
      .filter((target) => runOptions.skipTargetAuditKeys?.has(target.auditKey))
      .map((target) => target.auditKey);
    const targetResults: FileGuardResult[] = [];
    for (const target of targetFilesForAudit) {
      targetResults.push(await this.semanticGuard.analyzeMaskedFileWithEventsAsync(
        {
          path: target.file.path,
          content: this.contentForSemanticAudit(target.file.maskedContent)
        },
        target.maskingEvents
      ));
    }

    const unsafeTarget = targetResults.find((result) => result.blocked || result.excluded);
    if (unsafeTarget) {
      return this.rejected(
        requestDecision.request,
        requestDecision,
        targetFiles.map((target) => target.file.path),
        contextResults,
        targetResults,
        `修正対象コードのAIセキュリティ確認で停止しました。対象: ${unsafeTarget.path}。${unsafeTarget.excludeReason ?? "未マスク機密候補またはAIセキュリティ確認の失敗を検出しました。"}`
      );
    }

    return {
      accepted: true,
      request: requestDecision.request,
      reason: this.acceptedReason(contextResults.length, targetFiles, targetFilesForAudit, skippedTargetAuditKeys.length),
      targetPaths: targetFiles.map((target) => target.file.path),
      targetAuditKeys: targetFilesForAudit.map((target) => target.auditKey),
      skippedTargetAuditKeys,
      requestDecision,
      contextResults,
      targetResults
    };
  }

  private verifyContextPackage(contextPackage: ContextPackage): readonly FileGuardResult[] {
    return contextPackage.files.map((file) => this.contextGuard.analyzeFile({
      path: file.path,
      content: file.maskedContent
    }));
  }

  private contentForSemanticAudit(content: string): string {
    return content.replace(/__[A-Z0-9_]+_\d+__/g, "[removed]");
  }

  private maskingEventsFromPlaceholders(content: string): readonly MaskingEvent[] {
    const types = new Set<string>();
    for (const match of content.matchAll(/__([A-Z0-9_]+)_\d+__/g)) {
      const type = match[1];
      if (type) {
        types.add(type);
      }
    }

    return [...types].map((type) => ({
      detector: "send-time-placeholder",
      type,
      severity: this.severityForPlaceholderType(type),
      action: "mask"
    }));
  }

  private severityForPlaceholderType(type: string): MaskingEvent["severity"] {
    if (/PRIVATE_KEY|API_KEY|TOKEN|SECRET|PASSWORD|CONNECTION_STRING/.test(type)) {
      return "high";
    }

    return "medium";
  }

  private selectTargetFiles(request: MentorRequest, files: readonly ContextFile[]): readonly ContextFile[] {
    if (files.length === 0) {
      return [];
    }

    const requestedPaths = this.extractRequestedPaths(request);
    const matched = files.filter((file) => this.matchesRequestedPath(file.path, requestedPaths));
    const candidates = matched.length > 0
      ? matched
      : [...files].sort((left, right) => this.filePriority(right) - this.filePriority(left));

    const selected: ContextFile[] = [];
    let totalBytes = 0;
    for (const file of candidates) {
      if (selected.length >= this.maxTargetFiles) {
        break;
      }

      const size = new TextEncoder().encode(file.maskedContent).byteLength;
      if (selected.length > 0 && totalBytes + size > this.maxTargetBytes) {
        continue;
      }

      selected.push(file);
      totalBytes += size;
      if (totalBytes >= this.maxTargetBytes) {
        break;
      }
    }

    return selected;
  }

  private extractRequestedPaths(request: MentorRequest): readonly string[] {
    const source = request.task;
    const paths = new Set<string>();

    for (const line of source.split(/\r?\n/)) {
      const diffHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (diffHeader) {
        paths.add(this.normalizePath(diffHeader[1] ?? ""));
        paths.add(this.normalizePath(diffHeader[2] ?? ""));
      }

      const patchPath = line.match(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+)$/);
      if (patchPath && patchPath[1] !== "/dev/null") {
        paths.add(this.normalizePath(patchPath[1] ?? ""));
      }
    }

    const pathPattern = /(?:^|[\s"'(:])((?:[\w.-]+[\\/])+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|html|css|scss|md|py|java|kt|swift|go|rs|php|rb|cs|cpp|c|h|yml|yaml|toml|env))(?=$|[\s"',):;])/gi;
    for (const match of source.matchAll(pathPattern)) {
      paths.add(this.normalizePath(match[1] ?? ""));
    }

    return [...paths].filter((path) => path.length > 0);
  }

  private normalizePath(path: string): string {
    return path
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^(?:a|b)\//, "");
  }

  private matchesRequestedPath(path: string, requestedPaths: readonly string[]): boolean {
    if (requestedPaths.length === 0) {
      return false;
    }

    const normalized = this.normalizePath(path);
    return requestedPaths.some((requestedPath) => normalized === requestedPath || normalized.endsWith(`/${requestedPath}`));
  }

  private filePriority(file: ContextFile): number {
    const path = this.normalizePath(file.path).toLowerCase();
    let score = 0;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|swift|go|rs|php|rb|cs)$/.test(path)) {
      score += 20;
    }
    if (/(^|\/)(src|app|lib)\//.test(path)) {
      score += 10;
    }
    if (/(^|\/)(index|main|app|server|config)\./.test(path)) {
      score += 6;
    }
    if (file.maskedContent.includes("__")) {
      score += 4;
    }

    return score;
  }

  private targetLabel(files: readonly ContextFile[]): string {
    if (files.length === 0) {
      return "なし";
    }

    return files.map((file) => file.path).join(", ");
  }

  private acceptedReason(
    contextResultCount: number,
    targetFiles: readonly TargetFile[],
    targetFilesForAudit: readonly TargetFile[],
    skippedTargetCount: number
  ): string {
    const base = `送信前の安全確認を完了しました。ユーザープロンプトは機械検出を完了し、ContextPackage ${contextResultCount} 件は機械的再検査済み`;
    const audited = `機械検出済みの修正対象コード ${targetFilesForAudit.length} 件はAIによるセキュリティ確認済みです`;
    const skipped = skippedTargetCount > 0
      ? `、既出の修正対象コード ${skippedTargetCount} 件はAIによるセキュリティ確認を省略しました`
      : "";
    return `${base}、${audited}${skipped}。対象: ${this.targetLabel(targetFiles.map((target) => target.file))}`;
  }

  private targetAuditKey(file: ContextFile, maskingEvents: readonly MaskingEvent[]): string {
    const eventKey = maskingEvents
      .map((event) => `${event.type}:${event.severity}:${event.action}`)
      .sort()
      .join("|");
    return createHash("sha256")
      .update(file.path)
      .update("\0")
      .update(file.maskedContent)
      .update("\0")
      .update(eventKey)
      .digest("hex");
  }

  private rejected(
    request: MentorRequest,
    requestDecision: MentorRequestGuardDecision,
    targetPaths: readonly string[],
    contextResults: readonly FileGuardResult[],
    targetResults: readonly FileGuardResult[],
    reason: string
  ): SendTimeQuickAuditDecision {
    return {
      accepted: false,
      request,
      reason,
      targetPaths,
      targetAuditKeys: [],
      skippedTargetAuditKeys: [],
      requestDecision,
      contextResults,
      targetResults
    };
  }
}
