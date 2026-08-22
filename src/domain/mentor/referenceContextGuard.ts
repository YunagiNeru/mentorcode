import type { ContextPackage, MentorRequest, MentorResponse } from "../types";

export interface ReferenceContextIssue {
  readonly path: string;
  readonly reason: string;
}

export class ReferenceContextGuard {
  public inspect(request: MentorRequest, contextPackage: ContextPackage): readonly ReferenceContextIssue[] {
    const issues = new Map<string, ReferenceContextIssue>();

    for (const file of contextPackage.files) {
      if (file.contextSource !== "explicit_reference") {
        continue;
      }
      if (file.contentComplete === false || this.isUnexpectedlyEmpty(file)) {
        issues.set(this.normalizePath(file.path), {
          path: file.path,
          reason: this.incompleteReason(file.sourceSizeBytes, file.includedSizeBytes)
        });
      }
    }

    for (const file of contextPackage.blockedFiles) {
      if (file.contextSource !== "explicit_reference") {
        continue;
      }
      issues.set(this.normalizePath(file.path), {
        path: file.path,
        reason: file.reason
      });
    }

    for (const requestedPath of this.requestedPaths(request.task)) {
      const normalized = this.normalizePath(requestedPath);
      const included = contextPackage.files.find((file) => this.matchesReference(file.path, normalized));
      if (included) {
        if (included.contentComplete === false || this.isUnexpectedlyEmpty(included)) {
          issues.set(normalized, {
            path: requestedPath,
            reason: this.incompleteReason(included.sourceSizeBytes, included.includedSizeBytes)
          });
        }
        continue;
      }

      const blocked = contextPackage.blockedFiles.find((file) => this.matchesReference(file.path, normalized));
      issues.set(normalized, {
        path: requestedPath,
        reason: blocked?.reason ?? "指定された資料が送信コンテキストに含まれていません"
      });
    }

    return [...issues.values()];
  }

  public rejectionResponse(issues: readonly ReferenceContextIssue[]): MentorResponse {
    return {
      title: "指定資料を完全に確認できません",
      sections: [
        {
          heading: "確認できなかった対象",
          items: issues.map((issue) => `${issue.path}: ${issue.reason}`)
        },
        {
          heading: "次に必要なこと",
          items: [
            "資料を読めていない状態で一般論を返すことはせず、ここで停止しました。",
            "対象ファイルのサイズ、Privacy Guardの除外理由、メンター送信用コンテキスト上限を確認してから再送してください。"
          ]
        }
      ],
      policyWarnings: [
        "指定資料の完全性を確認できなかったため、外部LLMへの送信を中止しました。"
      ]
    };
  }

  private requestedPaths(task: string): readonly string[] {
    const paths = new Set<string>();
    for (const match of task.matchAll(/(?:^|\s)@([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*)/g)) {
      const path = this.normalizePath(match[1] ?? "");
      if (path) {
        paths.add(path);
      }
    }
    return [...paths];
  }

  private matchesReference(path: string, requestedPath: string): boolean {
    const normalizedPath = this.normalizePath(path);
    return normalizedPath === requestedPath || normalizedPath.startsWith(`${requestedPath}/`);
  }

  private normalizePath(path: string): string {
    return path.trim().replace(/^@/, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  }

  private isUnexpectedlyEmpty(file: ContextPackage["files"][number]): boolean {
    return (file.sourceSizeBytes ?? 0) > 0 && file.maskedContent.length === 0;
  }

  private incompleteReason(sourceSizeBytes?: number, includedSizeBytes?: number): string {
    if (sourceSizeBytes !== undefined && includedSizeBytes !== undefined) {
      return `資料全体を取得できませんでした（元サイズ ${sourceSizeBytes} bytes / 取得 ${includedSizeBytes} bytes）`;
    }
    return "資料全体を取得できませんでした";
  }
}
