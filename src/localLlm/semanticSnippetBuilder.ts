export interface SemanticSnippet {
  readonly path: string;
  readonly content: string;
}

export class SemanticSnippetBuilder {
  public build(path: string, content: string): SemanticSnippet {
    const normalized = content.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const selected = new Set<number>();
    const suspiciousPattern = /secret|token|password|credential|auth|key|customer|client|internal|confidential|private|社内|内部|秘密|認証|顧客|取引先|社員|個人情報|住所|電話|メール/i;

    lines.forEach((line, index) => {
      if (suspiciousPattern.test(line)) {
        for (let offset = -2; offset <= 2; offset += 1) {
          const candidate = index + offset;
          if (candidate >= 0 && candidate < lines.length) {
            selected.add(candidate);
          }
        }
      }
    });

    if (selected.size === 0) {
      for (let index = 0; index < Math.min(lines.length, 40); index += 1) {
        selected.add(index);
      }
    }

    const snippet = [...selected]
      .sort((left, right) => left - right)
      .map((index) => `${index + 1}: ${lines[index] ?? ""}`)
      .join("\n")
      .slice(0, 6000);

    return {
      path,
      content: snippet
    };
  }
}
