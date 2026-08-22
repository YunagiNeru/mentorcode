import type { ContextPackage, MentorRequest, MentorResponse } from "../../domain/types";

const GENERIC_TERMS = new Set([
  "project",
  "policy",
  "document",
  "プロジェクト",
  "ポリシー",
  "方針",
  "方針書",
  "資料",
  "文書",
  "内容",
  "確認",
  "把握",
  "分析",
  "開発"
]);

export class MentorGroundingGuard {
  public validate(
    response: MentorResponse,
    request: MentorRequest,
    contextPackage: ContextPackage
  ): readonly string[] {
    if (!this.requiresDocumentUnderstanding(request.task)) {
      return [];
    }

    const requestedPaths = this.requestedPaths(request.task);
    const referencedDocuments = contextPackage.files.filter((file) =>
      file.contentComplete !== false &&
      (
        file.contextSource === "explicit_reference" ||
        requestedPaths.some((path) => this.matchesReference(file.path, path))
      )
    );
    if (referencedDocuments.length === 0) {
      return [];
    }

    const responseText = this.responseText(response);
    const issues: string[] = [];
    if (this.delegatesDocumentReading(responseText)) {
      issues.push(
        "指定資料の読解をユーザーへ丸投げしています。files[]をAI側で読み、確認できた具体的事実を回答してください。"
      );
    }

    for (const document of referencedDocuments) {
      const anchors = this.documentAnchors(document.path, document.maskedContent);
      if (anchors.length < 2) {
        continue;
      }

      const matchedAnchors = anchors.filter((anchor) => responseText.includes(anchor));
      if (matchedAnchors.length < 2) {
        issues.push(
          `${document.path} のタイトル、見出し、概要に由来する具体語が不足しています。一般論ではなく、資料固有の事実を2点以上示してください。`
        );
      }
    }

    return issues;
  }

  private requiresDocumentUnderstanding(task: string): boolean {
    return /(?:確認|把握|分析|要約|読み取|読ん|調査)/.test(task);
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

  private responseText(response: MentorResponse): string {
    return this.normalize([
      response.title,
      ...response.sections.flatMap((section) => [section.heading, ...section.items])
    ].join("\n"));
  }

  private delegatesDocumentReading(text: string): boolean {
    return /(?:ご自身|自分|ユーザー).{0,32}(?:資料|文書|ファイル|内容|記述).{0,32}(?:開|読|確認|整理)/.test(text) ||
      /(?:資料|文書|ファイル|内容|記述).{0,32}(?:ご自身|自分|ユーザー).{0,32}(?:開|読|確認|整理)/.test(text);
  }

  private documentAnchors(path: string, content: string): readonly string[] {
    if (!/\.(?:html?|md|txt)$/i.test(path)) {
      return [];
    }

    const sources = /\.[x]?html?$/i.test(path)
      ? [
        ...this.htmlTagContents(content, "title"),
        ...this.htmlTagContents(content, "h1"),
        ...this.htmlTagContents(content, "h2"),
        ...this.htmlMetaDescriptions(content)
      ]
      : content
        .split(/\r?\n/)
        .filter((line) => /^\s{0,3}#{1,3}\s+/.test(line))
        .slice(0, 16);

    const anchors = new Set<string>();
    for (const source of sources) {
      const plainText = this.normalize(this.stripMarkup(source));
      for (const match of plainText.matchAll(/[a-z][a-z0-9.+-]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4,}/gu)) {
        const term = match[0] ?? "";
        if (!GENERIC_TERMS.has(term)) {
          anchors.add(term);
        }
      }
    }

    return [...anchors].slice(0, 32);
  }

  private htmlTagContents(content: string, tagName: string): readonly string[] {
    const values: string[] = [];
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        values.push(match[1]);
      }
    }
    return values.slice(0, 16);
  }

  private htmlMetaDescriptions(content: string): readonly string[] {
    const values: string[] = [];
    for (const match of content.matchAll(/<meta\b[^>]*\bcontent=(["'])(.*?)\1[^>]*\bname=(["'])description\3[^>]*>/gi)) {
      if (match[2]) {
        values.push(match[2]);
      }
    }
    for (const match of content.matchAll(/<meta\b[^>]*\bname=(["'])description\1[^>]*\bcontent=(["'])(.*?)\2[^>]*>/gi)) {
      if (match[3]) {
        values.push(match[3]);
      }
    }
    return values;
  }

  private stripMarkup(value: string): string {
    return value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, " ");
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, " ").trim();
  }

  private normalizePath(value: string): string {
    return value.trim().replace(/^@/, "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  }
}
