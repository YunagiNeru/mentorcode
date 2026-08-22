import { parseDocument } from "yaml";

export const SKILL_MANIFEST_FILE_NAME = "SKILL.md";
export const SKILL_MANIFEST_MAX_BYTES = 256 * 1024;

export type SkillManifestErrorCode =
  | "content_too_large"
  | "frontmatter_missing"
  | "frontmatter_unclosed"
  | "frontmatter_invalid"
  | "field_invalid"
  | "name_mismatch";

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly instructions: string;
}

export interface SkillManifestParseOptions {
  readonly expectedDirectoryName?: string;
}

export class SkillManifestError extends Error {
  public constructor(
    public readonly code: SkillManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SkillManifestError";
  }
}

export class SkillManifestParser {
  private static readonly supportedFields = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "disable-model-invocation",
    "user-invocable",
    "argument-hint",
    "model",
    "context",
    "agent",
    "hooks"
  ]);

  public parse(content: string, options: SkillManifestParseOptions = {}): SkillManifest {
    const normalized = content.replace(/^\uFEFF/, "");
    const byteLength = Buffer.byteLength(normalized, "utf8");
    if (byteLength > SKILL_MANIFEST_MAX_BYTES) {
      throw new SkillManifestError(
        "content_too_large",
        `${SKILL_MANIFEST_FILE_NAME} が上限 ${SKILL_MANIFEST_MAX_BYTES} バイトを超えています。`
      );
    }

    const source = this.splitFrontmatter(normalized);
    const frontmatter = this.parseFrontmatter(source.frontmatter);
    const name = frontmatter.name === undefined && options.expectedDirectoryName
      ? options.expectedDirectoryName
      : this.requiredString(frontmatter, "name", 64);
    this.validateName(name, options.expectedDirectoryName);
    const description = this.requiredString(frontmatter, "description", 1024);
    const license = this.optionalString(frontmatter, "license", 512);
    const compatibility = this.optionalString(frontmatter, "compatibility", 500);

    return {
      name,
      description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      metadata: this.metadata(frontmatter.metadata),
      allowedTools: this.allowedTools(frontmatter["allowed-tools"]),
      instructions: source.instructions.trim()
    };
  }

  private splitFrontmatter(content: string): { readonly frontmatter: string; readonly instructions: string } {
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
      throw new SkillManifestError(
        "frontmatter_missing",
        `${SKILL_MANIFEST_FILE_NAME} はYAML frontmatterで開始する必要があります。`
      );
    }

    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (closingIndex < 0) {
      throw new SkillManifestError(
        "frontmatter_unclosed",
        `${SKILL_MANIFEST_FILE_NAME} のYAML frontmatterが閉じられていません。`
      );
    }

    return {
      frontmatter: lines.slice(1, closingIndex).join("\n"),
      instructions: lines.slice(closingIndex + 1).join("\n")
    };
  }

  private parseFrontmatter(source: string): Record<string, unknown> {
    const document = parseDocument(source, {
      customTags: [],
      uniqueKeys: true
    });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.length > 0) {
      throw new SkillManifestError(
        "frontmatter_invalid",
        `YAML frontmatterを解析できません。${diagnostics[0]?.message ?? "形式が不正です。"}`
      );
    }

    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch (error) {
      throw new SkillManifestError(
        "frontmatter_invalid",
        `YAML frontmatterに許可されていない参照があります。${this.errorMessage(error)}`
      );
    }

    if (!this.isRecord(value)) {
      throw new SkillManifestError("frontmatter_invalid", "YAML frontmatterはオブジェクトである必要があります。");
    }

    const unsupported = Object.keys(value).find((key) => !SkillManifestParser.supportedFields.has(key));
    if (unsupported) {
      throw new SkillManifestError(
        "field_invalid",
        `YAML frontmatterに未対応のフィールドがあります: ${unsupported}`
      );
    }
    return value;
  }

  private validateName(name: string, expectedDirectoryName: string | undefined): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new SkillManifestError(
        "field_invalid",
        "nameは小文字英数字と単一ハイフンだけを使用し、先頭・末尾をハイフンにできません。"
      );
    }

    if (expectedDirectoryName !== undefined && name !== expectedDirectoryName) {
      throw new SkillManifestError(
        "name_mismatch",
        `name (${name}) が親ディレクトリ名 (${expectedDirectoryName}) と一致しません。`
      );
    }
  }

  private requiredString(value: Record<string, unknown>, key: string, maxLength: number): string {
    const field = value[key];
    if (typeof field !== "string" || field.trim().length === 0 || field.length > maxLength) {
      throw new SkillManifestError(
        "field_invalid",
        `${key}は1文字以上${maxLength}文字以下の文字列である必要があります。`
      );
    }
    return field.trim();
  }

  private optionalString(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
    const field = value[key];
    if (field === undefined) {
      return undefined;
    }
    if (typeof field !== "string" || field.trim().length === 0 || field.length > maxLength) {
      throw new SkillManifestError(
        "field_invalid",
        `${key}は1文字以上${maxLength}文字以下の文字列である必要があります。`
      );
    }
    return field.trim();
  }

  private metadata(value: unknown): Readonly<Record<string, string>> {
    if (value === undefined) {
      return {};
    }
    if (!this.isRecord(value)) {
      throw new SkillManifestError("field_invalid", "metadataは文字列値だけを持つオブジェクトである必要があります。");
    }

    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.trim().length === 0 || typeof item !== "string") {
        throw new SkillManifestError("field_invalid", "metadataは文字列キーと文字列値だけを使用できます。");
      }
      result[key] = item;
    }
    return result;
  }

  private allowedTools(value: unknown): readonly string[] {
    if (value === undefined) {
      return [];
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SkillManifestError("field_invalid", "allowed-toolsは空でない文字列である必要があります。");
    }
    return value.trim().split(/\s+/);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "形式が不正です。";
  }
}
