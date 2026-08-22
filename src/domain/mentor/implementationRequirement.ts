import type { MentorRequest } from "../types";
import { HintProfileResolver } from "./hintProfile";

export interface ImplementationRequirement {
  readonly requiresPatch: boolean;
  readonly reason?: string;
}

const TOOL_RESULT_PATTERNS = [
  /承認済みコマンドの実行結果/,
  /承認済みMCP Toolの実行結果/,
  /承認済み apply_patch/,
  /直前の apply_patch/,
  /conversationContext\.last(?:EditResult|CommandResult)/,
  /ユーザーが自力で実装完了/,
  /実装内容レビュー/,
  /patchApplyFailed/,
  /commandCompleted/,
  /editApplied/
];

const DIRECT_IMPLEMENTATION_PATTERNS = [
  /(?:実装|作成|開発|構築|修正|追加|変更|更新|生成|導入|セットアップ|環境構築)(?:を)?(?:し|して|したい|してください|する|行って|進めて|用意して|ほしい|ください)/,
  /(?:作って|直して|組んで|入れて|加えて|変えて)/,
  /\b(?:create|implement|build|fix|add|update|modify|setup|scaffold|generate|develop)\b/i
];

const IMPLEMENTATION_NOUN_PATTERN = /(?:実装|作成|開発|構築|修正|追加|変更|更新|生成|導入|セットアップ|環境構築|アプリ|API|エンドポイント|コンポーネント|画面|プロジェクト|機能|コード|ファイル)/;
const REVIEW_ONLY_PATTERN = /(?:確認|レビュー|チェック|動作確認|検証|できているか|問題ないか|どういうこと|なぜ|原因|説明)/;

export class ImplementationRequirementResolver {
  private readonly hintProfiles = new HintProfileResolver();

  public resolve(request: MentorRequest): ImplementationRequirement {
    const profile = this.hintProfiles.resolve(request.hintLevel);
    if (!profile.allowsImplementationActions) {
      return { requiresPatch: false };
    }

    const task = request.task.trim();
    if (!task || TOOL_RESULT_PATTERNS.some((pattern) => pattern.test(task))) {
      return { requiresPatch: false };
    }

    if (DIRECT_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(task))) {
      return {
        requiresPatch: true,
        reason: "現在のヒント段階で実装・作成・修正系の依頼を受けたため、有効な apply_patch が必要です。"
      };
    }

    if (IMPLEMENTATION_NOUN_PATTERN.test(task) && !REVIEW_ONLY_PATTERN.test(task)) {
      return {
        requiresPatch: true,
        reason: "実装対象を含む依頼のため、説明だけでなく有効な apply_patch が必要です。"
      };
    }

    return { requiresPatch: false };
  }
}
