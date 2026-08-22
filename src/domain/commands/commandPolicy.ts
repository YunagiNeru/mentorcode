import type { CommandApprovalCard, CommandRisk, CommandShell } from "../types";

interface CommandRule {
  readonly risk: CommandRisk;
  readonly pattern: RegExp;
  readonly hazard: string;
}

const COMMAND_RULES: readonly CommandRule[] = [
  {
    risk: "critical",
    pattern: /\b(rm\s+-rf|Remove-Item\b.*\b-Recurse\b|del\s+\/s|format\b|diskpart\b|git\s+reset\s+--hard|git\s+clean\s+-fd)\b/i,
    hazard: "ファイル削除、履歴破壊、復元困難な操作に該当する可能性があります。"
  },
  {
    risk: "high",
    pattern: /\b(curl|Invoke-WebRequest|wget|irm|iwr)\b.*\|\s*(sh|bash|powershell|pwsh)|\bnpm\s+install\b|\bpip\s+install\b|\bdocker\s+run\b/i,
    hazard: "外部取得物の実行または依存追加を伴う可能性があります。"
  },
  {
    risk: "medium",
    pattern: /\b(git\s+push|npm\s+publish|vsce\s+publish|docker\s+push|setx\b)\b/i,
    hazard: "外部公開、永続設定、環境変更を伴う可能性があります。"
  }
];

export class CommandPolicy {
  public createApprovalCard(
    command: string,
    workingDirectory: string,
    options: {
      readonly shell?: CommandShell;
      readonly meaning?: string;
      readonly expectedResult?: string;
      readonly allowedToExecute?: boolean;
    } = {}
  ): CommandApprovalCard {
    const trimmedCommand = command.trim();
    const hazards = this.detectHazards(trimmedCommand);
    const risk = this.maxRisk(hazards.map((hazard) => hazard.risk));

    return {
      ...(options.shell ? { shell: options.shell } : {}),
      command: trimmedCommand,
      workingDirectory: workingDirectory.trim() || ".",
      risk,
      meaning: options.meaning ?? this.describeMeaning(trimmedCommand),
      expectedResult: options.expectedResult ?? this.describeExpectedResult(trimmedCommand),
      hazards: hazards.length ? hazards.map((hazard) => hazard.hazard) : [
        "既知の高危険パターンは検出されていません。ただし実行前に作業ディレクトリと対象ファイルを確認してください。"
      ],
      rollback: this.describeRollback(risk),
      copyOnly: options.allowedToExecute === true ? false : true,
      allowedToExecute: options.allowedToExecute === true
    };
  }

  private detectHazards(command: string): readonly CommandRule[] {
    return COMMAND_RULES.filter((rule) => rule.pattern.test(command));
  }

  private maxRisk(risks: readonly CommandRisk[]): CommandRisk {
    const order: readonly CommandRisk[] = [
      "low",
      "medium",
      "high",
      "critical"
    ];

    return risks.reduce<CommandRisk>((current, next) => {
      return order.indexOf(next) > order.indexOf(current) ? next : current;
    }, "low");
  }

  private describeMeaning(command: string): string {
    if (!command) {
      return "コマンドが未入力です。";
    }

    if (/^npm\s+test\b/i.test(command)) {
      return "Node.jsプロジェクトのテストを実行します。";
    }

    if (/^npm\s+run\s+build\b/i.test(command)) {
      return "プロジェクトのビルドスクリプトを実行します。";
    }

    if (/^git\s+status\b/i.test(command)) {
      return "Gitの作業ツリー状態を確認します。";
    }

    return "入力されたコマンドの実行内容を事前確認します。承認後に指定シェルで実行できます。";
  }

  private describeExpectedResult(command: string): string {
    if (!command) {
      return "有効なコマンドを入力すると期待結果を確認できます。";
    }

    if (/^npm\s+test\b/i.test(command)) {
      return "全テストが成功し、失敗時は対象テスト名と原因が表示されます。";
    }

    if (/^npm\s+run\s+build\b/i.test(command)) {
      return "TypeScriptとWebview成果物がdist配下に生成されます。";
    }

    if (/^git\s+status\b/i.test(command)) {
      return "変更済み、未追跡、ステージ済みファイルの一覧が表示されます。";
    }

    return "実行前に、標準出力、生成物、変更対象、失敗時の戻し方を確認してください。";
  }

  private describeRollback(risk: CommandRisk): readonly string[] {
    if (risk === "critical") {
      return [
        "実行するとファイル削除や履歴破壊が起きる可能性があります。",
        "必要な場合は作業ツリー、バックアップ、復元手順を先に用意してください。"
      ];
    }

    if (risk === "high") {
      return [
        "依存追加や外部取得がある場合は、変更ファイルとロックファイルを確認してください。",
        "不要なら追加された依存と生成物を削除し、テストを再実行してください。"
      ];
    }

    return [
      "実行前の状態を確認し、変更が出た場合は差分を読んでから戻すか判断してください。"
    ];
  }
}
