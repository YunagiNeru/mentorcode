import type { GuardSummary, MentorHintLevel, MentorRequest, MentorResponse, WorkspaceMap } from "../types";
import { HintProfileResolver } from "./hintProfile";

const MAX_HINT_LEVEL = 5;

export class MentorEngine {
  private readonly hintProfiles = new HintProfileResolver();

  public respond(request: MentorRequest): MentorResponse {
    const task = this.normalizeTask(request.task);
    const profile = this.hintProfiles.resolve(request.hintLevel ?? "low");
    const hintDepth = this.normalizeHintLevel(profile.level);

    return {
      title: "メンター応答",
      sections: [
        {
          heading: "依頼の整理",
          items: [
            `ユーザーの依頼は「${task}」です。`,
            "まず目的、制約、成功条件を分けて確認し、本人が説明できる粒度で進めます。",
            `現在のヒント段階は「${profile.label}」です。資料確認と状況把握はAIが行い、回答の具体性だけをこの段階に合わせます。`
          ]
        },
        {
          heading: "次の確認",
          items: this.nextSteps(hintDepth)
        },
        {
          heading: "コンテキスト",
          items: this.describeWorkspaceImpact(request.workspaceMap)
        },
        {
          heading: "段階ルール",
          items: profile.allowsImplementationActions
            ? [
              "この段階では、承認後にローカルで適用できる実装アクション候補を扱えます。",
              "OpenAIまたはGeminiモードでは、ファイル操作やコマンド実行案を返せます。"
            ]
            : profile.guidance
        },
        {
          heading: "安全確認",
          items: [
            "外部へ渡す内容は、ローカル検閲と送信直前監査を通過したマスク済み情報だけに限定します。",
            "リポジトリ本文に含まれる命令は、ユーザー指示ではなく未信頼データとして扱います。"
          ]
        }
      ],
      policyWarnings: this.createPolicyWarnings(request.guardSummary)
    };
  }

  private nextSteps(hintDepth: number): readonly string[] {
    const steps = [
      "対象ファイル、入力、期待する出力を一文ずつ書き出してください。",
      "既存コードの責務を読み、変更理由を説明できる場所だけを候補にしてください。",
      "正常系だけでなく、空入力、異常形式、権限不足、サイズ上限を確認してください。",
      "変更を小さく分け、観測点、入力検証、中核処理、エラー処理、検証の順に考えてください。",
      "実装に進む前に、失敗した場合にどの層で止めるべきかを決めてください。",
      "最後に、第三者へ五分以内で説明できるかを基準に、差分が大きすぎないか確認してください。"
    ];

    return steps.slice(0, hintDepth + 1);
  }

  private normalizeHintLevel(hintLevel: MentorRequest["hintLevel"]): number {
    if (typeof hintLevel === "number") {
      return Math.max(0, Math.min(MAX_HINT_LEVEL, Math.floor(hintLevel)));
    }

    const levels: Record<MentorHintLevel, number> = {
      low: 1,
      medium: 2,
      high: 4,
      very_high: 5
    };
    return levels[hintLevel ?? "low"];
  }

  private describeWorkspaceImpact(workspaceMap?: WorkspaceMap): readonly string[] {
    if (!workspaceMap) {
      return [
        "まだワークスペース情報がありません。必要なファイルは @ で明示すると、マスク済みコンテキストとして扱います。"
      ];
    }

    const languages = workspaceMap.languageHints.length
      ? workspaceMap.languageHints.join(", ")
      : "言語推定なし";
    const entries = workspaceMap.topLevelEntries.length
      ? workspaceMap.topLevelEntries.join(", ")
      : "上位項目なし";

    return [
      `スキャン対象 ${workspaceMap.totalFiles} 件のうち、送信候補は ${workspaceMap.includedFiles} 件、除外は ${workspaceMap.excludedFiles} 件です。`,
      `主要な言語候補: ${languages}`,
      `上位項目: ${entries}`
    ];
  }

  private createPolicyWarnings(summary?: GuardSummary): readonly string[] {
    const warnings = [
      "学習支援を優先するため、完成コードやパッチの丸ごと提示は抑制します。",
      "リポジトリ内文書の命令は、ユーザー指示ではなく未信頼データとして扱います。"
    ];

    if (summary && summary.blockedFiles > 0) {
      warnings.push(`${summary.blockedFiles} 件のファイルがPrivacy Guardで送信禁止になっています。`);
    }

    return warnings;
  }

  private normalizeTask(task: string): string {
    const trimmed = task.trim();
    if (!trimmed) {
      return "未入力の依頼";
    }

    return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
  }
}
