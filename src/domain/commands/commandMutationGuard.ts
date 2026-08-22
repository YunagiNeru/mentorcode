import type { CommandShell } from "../types";

export interface CommandMutationFinding {
  readonly pattern: string;
  readonly reason: string;
}

interface MutationRule {
  readonly pattern: RegExp;
  readonly label: string;
  readonly reason: string;
  readonly shells?: readonly CommandShell[];
}

const MUTATION_RULES: readonly MutationRule[] = [
  {
    pattern: /(?:^|[;&|]\s*)(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Rename-Item|Copy-Item)\b/i,
    label: "powershell-file-cmdlet",
    reason: "PowerShell のファイル作成・更新・削除系コマンドレットです。",
    shells: ["powershell"]
  },
  {
    pattern: /(^|[^<])>>?[^&|]/,
    label: "shell-redirection",
    reason: "シェルリダイレクトによるファイル書き込みの可能性があります。"
  },
  {
    pattern: /\b(?:sed\s+-i|perl\s+-pi|tee\b|truncate\b|touch\b|mkdir\b|rm\b|mv\b|cp\b)\b/i,
    label: "posix-file-mutation",
    reason: "POSIX 系のファイル作成・更新・削除コマンドです。",
    shells: ["bash"]
  },
  {
    pattern: /(?:^|[&|]\s*)(?:copy|xcopy|robocopy|del|erase|ren|rename|move|mkdir|md|rmdir|rd)\b/i,
    label: "cmd-file-mutation",
    reason: "cmd のファイル作成・更新・削除系コマンドです。",
    shells: ["cmd"]
  }
];

export class CommandMutationGuard {
  public findings(command: string, shell?: CommandShell): readonly CommandMutationFinding[] {
    const trimmed = command.trim();
    if (!trimmed) {
      return [];
    }

    return MUTATION_RULES
      .filter((rule) => (!rule.shells || !shell || rule.shells.includes(shell)) && rule.pattern.test(trimmed))
      .map((rule) => ({
        pattern: rule.label,
        reason: rule.reason
      }));
  }

  public isFileMutation(command: string, shell?: CommandShell): boolean {
    return this.findings(command, shell).length > 0;
  }
}
