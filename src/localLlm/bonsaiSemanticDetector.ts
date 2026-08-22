import type { AsyncSemanticDetector, SemanticDetectionResult, SemanticFileInput } from "../domain/privacy/semanticTypes";
import type { DetectionFinding, GuardAction, LocalLlmReview, MaskingEvent, Severity } from "../domain/types";
import { BonsaiRuntime, type BonsaiClassification } from "./bonsaiRuntime";
import { SemanticSnippetBuilder } from "./semanticSnippetBuilder";

export interface BonsaiSemanticDetectorOptions {
  readonly blockConfidence?: number;
  readonly runtime: Pick<BonsaiRuntime, "classify" | "verify">;
}

export class BonsaiSemanticDetector implements AsyncSemanticDetector {
  public readonly name = "bonsai-1bit-semantic";
  private readonly snippetBuilder = new SemanticSnippetBuilder();
  private readonly blockConfidence: number;

  public constructor(private readonly options: BonsaiSemanticDetectorOptions) {
    this.blockConfidence = options.blockConfidence ?? 0.7;
  }

  public async detectFile(file: SemanticFileInput): Promise<SemanticDetectionResult> {
    await this.options.runtime.verify();
    const snippet = this.snippetBuilder.build(file.path, file.maskedContent);
    const classification = await this.options.runtime.classify(snippet.path, this.createReviewInput(file, snippet.content));
    return {
      findings: this.toFindings(classification),
      review: this.toReview(classification, file)
    };
  }

  private createReviewInput(file: SemanticFileInput, snippet: string): string {
    return [
      "Mechanical detections below are facts from deterministic local detectors.",
      "Every placeholder like __TYPE_1__ is a redacted original value that must stay redacted.",
      "Do not suggest replacing a placeholder with a real value, restoring it, guessing it, or asking the user to paste it.",
      "Explain risk using only detector types, severities, actions, and reasons.",
      "Evaluate whether masked context still contains residual confidential meaning.",
      "If recommending action, recommend rotation, revocation, masking, exclusion, or safe storage. Never recommend unmasking.",
      "Mechanical detections:",
      JSON.stringify(file.maskingEvents.map((event) => ({
        type: event.type,
        severity: event.severity,
        action: event.action,
        placeholder: event.placeholder
      }))),
      "Masked snippet:",
      snippet
    ].join("\n");
  }

  private toFindings(classification: BonsaiClassification): readonly DetectionFinding[] {
    if (classification.verdict === "safe") {
      return [];
    }

    const severity = this.severityFor(classification);
    const action: GuardAction = classification.confidence >= this.blockConfidence ? "block" : "warn";
    return [
      {
        id: `bonsai-${classification.verdict}`,
        detector: this.name,
        type: this.typeFor(classification.verdict),
        severity,
        action,
        start: 0,
        end: 0,
        reason: this.reasonFor(classification.verdict, classification.confidence)
      }
    ];
  }

  private typeFor(verdict: BonsaiClassification["verdict"]): string {
    return `BONSAI_${verdict.toUpperCase()}`;
  }

  private severityFor(classification: BonsaiClassification): Severity {
    if (classification.verdict === "credential_likely") {
      return "critical";
    }

    if (classification.confidence >= this.blockConfidence) {
      return "high";
    }

    return "medium";
  }

  private reasonFor(verdict: BonsaiClassification["verdict"], confidence: number): string {
    const label = verdict.replace(/_/g, " ");
    return `1-Bit Bonsai 1.7B detected ${label} context locally with confidence ${confidence.toFixed(2)}.`;
  }

  private toReview(classification: BonsaiClassification, file: SemanticFileInput): LocalLlmReview {
    const detectedTypes = this.detectedTypes(file.maskingEvents, classification);
    return {
      status: "completed",
      model: "1-Bit Bonsai 1.7B",
      location: "vscode_extension_host",
      verdict: classification.verdict,
      confidence: classification.confidence,
      detectedTypes,
      educationSummary: this.defaultEducationSummary(classification, detectedTypes),
      riskPoints: this.defaultRiskPoints(file.maskingEvents, classification),
      recommendedAction: this.defaultRecommendedAction(file.maskingEvents),
      guidanceSource: "safety_template",
      guidanceSourceReason: "Bonsai分類JSONの verdict と confidence を取得し、表示文は安全テンプレートで生成しています。"
    };
  }

  private detectedTypes(events: readonly MaskingEvent[], classification: BonsaiClassification): readonly string[] {
    const types = events
      .filter((event) => event.action === "mask" || event.action === "block")
      .map((event) => event.type);

    if (classification.verdict !== "safe") {
      types.push(this.typeFor(classification.verdict));
    }

    return [...new Set(types)];
  }

  private defaultEducationSummary(classification: BonsaiClassification, detectedTypes: readonly string[]): string {
    if (detectedTypes.length === 0 && classification.verdict === "safe") {
      return "AIによるセキュリティ確認では、マスク後本文に追加でブロックすべき曖昧な機密文脈は検出されませんでした。";
    }

    return `AIによるセキュリティ確認では、機械検出でマスク済みの ${detectedTypes.join(", ")} を外部送信前に注意すべき情報として評価しました。`;
  }

  private defaultRiskPoints(events: readonly MaskingEvent[], classification: BonsaiClassification): readonly string[] {
    if (events.length === 0 && classification.verdict === "safe") {
      return [];
    }

    const points = events
      .filter((event) => event.action === "mask" || event.action === "block")
      .map((event) => this.riskPointFor(event.type));

    if (classification.verdict !== "safe") {
      points.push("コードや文章の文脈から、単純な文字列形式だけでは判断しにくい内部情報または認証情報の可能性があります。");
    }

    return points.length > 0
      ? [...new Set(points)]
      : ["マスク後本文に対して、AIによるセキュリティ確認が追加の曖昧な機密リスクを確認しました。"];
  }

  private riskPointFor(type: string): string {
    if (type.includes("API_KEY") || type.includes("TOKEN") || type.includes("SECRET") || type.includes("PASSWORD")) {
      return "APIキーやトークンは外部サービスの認証情報であり、漏洩すると第三者利用、課金被害、権限悪用につながります。";
    }

    if (type.includes("INTERNAL_URL") || type.includes("CONNECTION_STRING")) {
      return "内部URLや接続文字列は、社内構成、ネットワーク境界、DB接続先を推測されるリスクがあります。";
    }

    if (type.includes("EMAIL") || type.includes("PHONE")) {
      return "メールアドレスや電話番号は個人情報に該当し、本人同意なしに外部送信すべきではありません。";
    }

    return `${type} は外部LLMへ送る前にマスクまたは除外すべき機密情報候補です。`;
  }

  private defaultRecommendedAction(events: readonly MaskingEvent[]): string {
    const hasCredential = events.some((event) => /API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY/.test(event.type));
    if (hasCredential) {
      return "実値を無効化・再発行し、環境変数、Secret Manager、OSの安全な資格情報ストアへ移してください。";
    }

    return "マスク済みプレビューだけを共有し、元の値や内部識別子をチャット、Issue、ログへ貼らないでください。";
  }

}
