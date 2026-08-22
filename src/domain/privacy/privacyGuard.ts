import type {
  ContextPackage,
  DetectionFinding,
  FileCandidate,
  FileGuardResult,
  GuardSummary,
  LocalLlmReview,
  MaskingEvent
} from "../types";
import type { AsyncSemanticDetector } from "./semanticTypes";
import {
  EntropyDetector,
  LocalSemanticDetector,
  PiiDetector,
  SecretPatternDetector,
  type Detector
} from "./detectors";
import { MaskingEngine } from "./maskingEngine";
import { PathPolicy } from "./pathPolicy";

export interface PrivacyGuardOptions {
  readonly detectors?: readonly Detector[];
  readonly semanticDetector?: AsyncSemanticDetector;
  readonly requireSemanticScan?: boolean;
  readonly maxFileBytes?: number;
}

export class PrivacyGuard {
  private readonly pathPolicy = new PathPolicy();
  private readonly maskingEngine = new MaskingEngine();
  private readonly detectors: readonly Detector[];
  private readonly semanticDetector: AsyncSemanticDetector | undefined;
  private readonly requireSemanticScan: boolean;
  private readonly maxFileBytes: number;

  public constructor(options: PrivacyGuardOptions = {}) {
    this.detectors = options.detectors ?? [
      new SecretPatternDetector(),
      new EntropyDetector(),
      new PiiDetector(),
      new LocalSemanticDetector()
    ];
    this.semanticDetector = options.semanticDetector;
    this.requireSemanticScan = options.requireSemanticScan ?? false;
    this.maxFileBytes = options.maxFileBytes ?? 120_000;
  }

  public analyzeFile(file: FileCandidate): FileGuardResult {
    const pathDecision = this.pathPolicy.evaluate(file.path);
    if (!pathDecision.allowed) {
      return {
        path: file.path,
        blocked: true,
        excluded: true,
        excludeReason: pathDecision.reason,
        findings: [],
        maskingEvents: []
      };
    }

    const size = file.sizeBytes ?? new TextEncoder().encode(file.content).byteLength;
    if (size > this.maxFileBytes) {
      return {
        path: file.path,
        blocked: true,
        excluded: true,
        excludeReason: `ファイルサイズが上限 ${this.maxFileBytes} bytes を超えています`,
        findings: [],
        maskingEvents: []
      };
    }

    if (this.looksBinary(file.content)) {
      return {
        path: file.path,
        blocked: true,
        excluded: true,
        excludeReason: "バイナリファイルの可能性があるため送信禁止です",
        findings: [],
        maskingEvents: []
      };
    }

    const findings = this.detect(file.content);
    const hasBlockingFinding = findings.some((finding) => finding.action === "block");
    if (hasBlockingFinding) {
      return {
        path: file.path,
        blocked: true,
        excluded: true,
        excludeReason: "高リスク秘密情報を検出したためファイル全体を送信禁止にしました",
        findings,
        maskingEvents: findings.map((finding) => ({
          detector: finding.detector,
          type: finding.type,
          severity: finding.severity,
          action: finding.action
        }))
      };
    }

    const masked = this.maskingEngine.mask(file.content, findings);
    const verificationFindings = this.detect(masked.content).filter((finding) => finding.action !== "warn");
    if (verificationFindings.length > 0) {
      return {
        path: file.path,
        blocked: true,
        excluded: true,
        excludeReason: "マスク後の再検査で未処理の秘密情報候補が残ったため送信禁止にしました",
        findings: [
          ...masked.findings,
          ...verificationFindings
        ],
        maskingEvents: masked.events
      };
    }

    return {
      path: file.path,
      blocked: false,
      excluded: false,
      maskedContent: masked.content,
      findings: masked.findings,
      maskingEvents: masked.events
    };
  }

  public async analyzeFileAsync(file: FileCandidate): Promise<FileGuardResult> {
    const mechanicalResult = this.analyzeFile(file);
    if (mechanicalResult.blocked || mechanicalResult.excluded || mechanicalResult.maskedContent === undefined) {
      return mechanicalResult;
    }

    if (!this.needsSemanticScan(mechanicalResult.maskingEvents)) {
      return mechanicalResult;
    }

    return this.applySemanticScan(file, mechanicalResult, mechanicalResult.maskingEvents);
  }

  public async analyzeMaskedFileWithEventsAsync(
    file: FileCandidate,
    maskingEvents: readonly MaskingEvent[]
  ): Promise<FileGuardResult> {
    const mechanicalResult = this.analyzeFile(file);
    if (mechanicalResult.blocked || mechanicalResult.excluded || mechanicalResult.maskedContent === undefined) {
      return mechanicalResult;
    }

    if (!this.needsSemanticScan(maskingEvents)) {
      return mechanicalResult;
    }

    return this.applySemanticScan(file, mechanicalResult, maskingEvents);
  }

  private async applySemanticScan(
    file: FileCandidate,
    mechanicalResult: FileGuardResult,
    maskingEvents: readonly MaskingEvent[]
  ): Promise<FileGuardResult> {
    if (!this.semanticDetector) {
      return this.withSemanticFailureWarning(
        mechanicalResult,
        maskingEvents,
        "1-Bit Bonsai 1.7B semantic scan is not configured."
      );
    }

    const maskedContent = mechanicalResult.maskedContent;
    if (maskedContent === undefined) {
      return mechanicalResult;
    }

    try {
      const semanticResult = await this.semanticDetector.detectFile({
        ...file,
        maskedContent,
        findings: mechanicalResult.findings,
        maskingEvents
      });

      const semanticFindings = this.nonBlockingSemanticFindings(semanticResult.findings);
      const findings = [
        ...mechanicalResult.findings,
        ...semanticFindings
      ];
      return {
        ...mechanicalResult,
        findings,
        localLlmReview: semanticResult.review,
        maskingEvents: [
          ...maskingEvents,
          ...semanticFindings.map((finding) => ({
            detector: finding.detector,
            type: finding.type,
            severity: finding.severity,
            action: finding.action
          }))
        ]
      };
    } catch (error) {
      const failureReason = this.semanticFailureReason(error);
      return this.withSemanticFailureWarning(
        mechanicalResult,
        maskingEvents,
        `1-Bit Bonsai 1.7B semantic scan failed: ${failureReason}.`
      );
    }
  }

  public createContextPackage(files: readonly FileCandidate[]): ContextPackage {
    const results = files.map((file) => this.analyzeFile(file));
    const includedFiles = results
      .filter((result) => !result.blocked && !result.excluded && result.maskedContent !== undefined)
      .map((result) => ({
        path: result.path,
        maskedContent: result.maskedContent ?? "",
        ...(result.localLlmReview ? { localLlmReview: result.localLlmReview } : {})
      }));

    const blockedFiles = results
      .filter((result) => result.blocked || result.excluded)
      .map((result) => ({
        path: result.path,
        reason: result.excludeReason ?? "送信禁止です",
        ...(result.localLlmReview ? { localLlmReview: result.localLlmReview } : {})
      }));

    return {
      files: includedFiles,
      blockedFiles,
      summary: this.summarize(results)
    };
  }

  public async createContextPackageAsync(files: readonly FileCandidate[]): Promise<ContextPackage> {
    const results: FileGuardResult[] = [];
    for (const file of files) {
      results.push(await this.analyzeFileAsync(file));
    }

    const includedFiles = results
      .filter((result) => !result.blocked && !result.excluded && result.maskedContent !== undefined)
      .map((result) => ({
        path: result.path,
        maskedContent: result.maskedContent ?? "",
        ...(result.localLlmReview ? { localLlmReview: result.localLlmReview } : {})
      }));

    const blockedFiles = results
      .filter((result) => result.blocked || result.excluded)
      .map((result) => ({
        path: result.path,
        reason: result.excludeReason ?? "送信禁止です",
        ...(result.localLlmReview ? { localLlmReview: result.localLlmReview } : {})
      }));

    return {
      files: includedFiles,
      blockedFiles,
      summary: this.summarize(results)
    };
  }

  public summarize(results: readonly FileGuardResult[]): GuardSummary {
    const allFindings = results.flatMap((result) => result.findings);

    return {
      scannedFiles: results.length,
      includedFiles: results.filter((result) => !result.blocked && !result.excluded).length,
      blockedFiles: results.filter((result) => result.blocked || result.excluded).length,
      maskedFindings: allFindings.filter((finding) => finding.action === "mask").length,
      warningFindings: allFindings.filter((finding) => finding.action === "warn").length,
      criticalFindings: allFindings.filter((finding) => finding.severity === "critical").length
    };
  }

  private detect(content: string): readonly DetectionFinding[] {
    return this.detectors.flatMap((detector) => detector.detect(content));
  }

  private needsSemanticScan(events: readonly MaskingEvent[]): boolean {
    return events.some((event) => event.action === "mask" || event.action === "block");
  }

  private looksBinary(content: string): boolean {
    if (content.length === 0) {
      return false;
    }

    const sample = content.slice(0, 4096);
    let controlCharacters = 0;
    for (const character of sample) {
      const code = character.charCodeAt(0);
      if (code === 0) {
        return true;
      }
      if (code < 8 || (code > 13 && code < 32)) {
        controlCharacters += 1;
      }
    }

    return controlCharacters / sample.length > 0.05;
  }

  private nonBlockingSemanticFindings(findings: readonly DetectionFinding[]): readonly DetectionFinding[] {
    return findings.map((finding) => ({
      ...finding,
      action: finding.action === "block" ? "warn" : finding.action
    }));
  }

  private withSemanticFailureWarning(
    mechanicalResult: FileGuardResult,
    maskingEvents: readonly MaskingEvent[],
    reason: string,
  ): FileGuardResult {
    const failureFinding: DetectionFinding = {
      id: "bonsai-unavailable",
      detector: "bonsai-1bit-semantic",
      type: "LOCAL_LLM_UNAVAILABLE",
      severity: "medium",
      action: "warn",
      start: 0,
      end: 0,
      reason
    };

    return {
      ...mechanicalResult,
      localLlmReview: this.createSemanticFailureReview(reason, mechanicalResult.findings),
      findings: [
        ...mechanicalResult.findings,
        failureFinding
      ],
      maskingEvents: [
        ...maskingEvents,
        {
          detector: failureFinding.detector,
          type: failureFinding.type,
          severity: failureFinding.severity,
          action: failureFinding.action
        }
      ]
    };
  }

  private createSemanticFailureReview(reason: string, findings: readonly DetectionFinding[]): LocalLlmReview {
    return {
      status: "failed",
      model: "1-Bit Bonsai 1.7B",
      location: "vscode_extension_host",
      detectedTypes: this.uniqueDetectedTypes(findings),
      educationSummary: "AIによるセキュリティ確認を完了できなかったため、この内容は外部送信候補から除外されます。",
      riskPoints: [
        "AIによる確認が完了しない場合、曖昧な機密文脈を安全に判断できません。",
        "秘密情報の流出を防ぐため、評価失敗時はfail closedで止めます。"
      ],
      recommendedAction: "セキュリティ確認の実行環境を確認してから再検査してください。",
      guidanceSource: "safety_template",
      guidanceSourceReason: "AIによるセキュリティ確認が完了しなかったため、安全テンプレート説明を表示しています。",
      failureReason: reason
    };
  }

  private uniqueDetectedTypes(findings: readonly DetectionFinding[]): readonly string[] {
    return [...new Set(findings.map((finding) => finding.type))];
  }

  private semanticFailureReason(error: unknown): string {
    const rawMessage = error instanceof Error ? error.message : "unknown error";
    return rawMessage
      .replace(/[A-Z]:\\[^\s]+/g, "[LOCAL_PATH]")
      .replace(/\s+/g, " ")
      .slice(0, 240);
  }
}
