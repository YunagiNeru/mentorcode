import type { MentorHintLevel, MentorRequest } from "../types";

export interface HintProfile {
  readonly level: MentorHintLevel;
  readonly label: string;
  readonly allowsImplementationActions: boolean;
  readonly guidance: readonly string[];
}

const PROFILES: Record<MentorHintLevel, HintProfile> = {
  low: {
    level: "low",
    label: "低",
    allowsImplementationActions: false,
    guidance: [
      "AI側で必要な資料と現状を先に把握し、確認できた具体的事実、考える焦点、次の一歩を簡潔に返す。",
      "完成解答は直接示さず、ユーザー自身が判断できる問いや観点を残す。",
      "コード実装、ファイル作成・編集・削除・リネーム、コマンド実行案は行わない。"
    ]
  },
  medium: {
    level: "medium",
    label: "中",
    allowsImplementationActions: false,
    guidance: [
      "AI側で資料と現状を把握したうえで、対象ファイル、責務分解、実装順序を具体化する。",
      "コード実装、ファイル作成・編集・削除・リネーム、コマンド実行案は行わない。"
    ]
  },
  high: {
    level: "high",
    label: "高",
    allowsImplementationActions: true,
    guidance: [
      "ユーザーが確認できる説明と、承認後に適用できるローカル実装アクション候補を返してよい。",
      "ファイル作成・編集・削除・リネーム、コマンド実行案はいずれもユーザー承認を前提にする。"
    ]
  },
  very_high: {
    level: "very_high",
    label: "非常に高い",
    allowsImplementationActions: true,
    guidance: [
      "LLM側で実装判断を深く行い、より完成度の高いローカル実装アクション候補を返してよい。",
      "ファイル作成・編集・削除・リネーム、コマンド実行案はいずれもユーザー承認を前提にし、検証観点も明記する。"
    ]
  }
};

export class HintProfileResolver {
  public resolve(value: MentorRequest["hintLevel"] = "low"): HintProfile {
    if (typeof value === "number") {
      if (value >= 5) {
        return PROFILES.very_high;
      }
      if (value >= 4) {
        return PROFILES.high;
      }
      if (value >= 2) {
        return PROFILES.medium;
      }
      return PROFILES.low;
    }

    return PROFILES[value ?? "low"];
  }
}
