import * as linguistLanguages from "linguist-languages";
import type { Language as LinguistLanguage } from "linguist-languages";
import { bundledLanguagesInfo, codeToTokens } from "shiki/bundle/full";
import type { BundledLanguage, BundledTheme, ThemedToken } from "shiki/bundle/full";

export type SyntaxHighlightTheme = Extract<BundledTheme, "dark-plus" | "light-plus">;

export interface HighlightedToken {
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
}

export interface HighlightedCode {
  readonly lines: readonly (readonly HighlightedToken[])[];
  readonly language: string;
  readonly highlighted: boolean;
  readonly theme: SyntaxHighlightTheme;
}

const PLAIN_TEXT_LANGUAGE = "text";
const DARK_THEME: SyntaxHighlightTheme = "dark-plus";
const LIGHT_THEME: SyntaxHighlightTheme = "light-plus";

const supportedLanguages = new Map<string, BundledLanguage>();
for (const language of bundledLanguagesInfo) {
  const languageId = language.id as BundledLanguage;
  registerSupportedLanguage(language.id, languageId);
  for (const alias of language.aliases ?? []) {
    registerSupportedLanguage(alias, languageId);
  }
}

const linguistLanguageOverrides = new Map<string, BundledLanguage>([
  ["1c-enterprise", "bsl"],
  ["actionscript", "actionscript-3"],
  ["batchfile", "bat"],
  ["c#", "csharp"],
  ["csharp", "csharp"],
  ["c++", "cpp"],
  ["cpp", "cpp"],
  ["common-lisp", "common-lisp"],
  ["dockerfile", "dockerfile"],
  ["emacs-lisp", "emacs-lisp"],
  ["f#", "fsharp"],
  ["fsharp", "fsharp"],
  ["makefile", "make"],
  ["objective-c++", "objective-cpp"],
  ["objective-cpp", "objective-cpp"],
  ["objective-c", "objective-c"],
  ["protocol-buffer", "proto"],
  ["protocol-buffer-text-format", "proto"],
  ["shell", "shellscript"],
  ["systemverilog", "system-verilog"],
  ["vim-script", "viml"],
  ["visual-basic-net", "vb"],
  ["wolfram-language", "wolfram"]
]);

const fileNameLanguages = new Map<string, BundledLanguage>([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["rakefile", "ruby"],
  ["gemfile", "ruby"],
  ["podfile", "ruby"],
  ["cmakelists.txt", "cmake"],
  ["pom.xml", "xml"]
]);

const extensionLanguages = new Map<string, BundledLanguage>();
for (const language of Object.values(linguistLanguages) as LinguistLanguage[]) {
  const resolvedLanguage = resolveLinguistLanguage(language);
  if (!resolvedLanguage) {
    continue;
  }

  for (const extension of language.extensions ?? []) {
    registerLanguageHint(extensionLanguages, extension.replace(/^\./, ""), resolvedLanguage);
  }

  for (const fileName of language.filenames ?? []) {
    registerLanguageHint(fileNameLanguages, fileName, resolvedLanguage);
  }
}

const extensionLanguageOverrides = new Map<string, BundledLanguage>([
  ["cjs", "javascript"],
  ["cts", "typescript"],
  ["env", "dotenv"],
  ["env.local", "dotenv"],
  ["env.production", "dotenv"],
  ["env.development", "dotenv"],
  ["env.test", "dotenv"],
  ["env.example", "dotenv"],
  ["gradle", "groovy"],
  ["json5", "json"],
  ["mjs", "javascript"],
  ["mts", "typescript"],
  ["properties", "ini"],
  ["ps1", "powershell"],
  ["psd1", "powershell"],
  ["psm1", "powershell"],
  ["yml", "yaml"]
]);

function registerSupportedLanguage(candidate: string, languageId: BundledLanguage): void {
  registerLanguageHint(supportedLanguages, candidate, languageId);
  registerLanguageHint(supportedLanguages, normalizeLanguageKey(candidate), languageId);
}

function registerLanguageHint(target: Map<string, BundledLanguage>, candidate: string, languageId: BundledLanguage): void {
  const key = candidate.trim().toLowerCase();
  if (key && !target.has(key)) {
    target.set(key, languageId);
  }
}

function resolveLinguistLanguage(language: LinguistLanguage): BundledLanguage | undefined {
  const candidates = [
    language.name,
    ...language.aliases ?? [],
    language.aceMode,
    language.codemirrorMode,
    language.group
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeLanguageKey(candidate);
    const overridden = linguistLanguageOverrides.get(candidate.toLowerCase()) ?? linguistLanguageOverrides.get(normalizedCandidate);
    if (overridden) {
      return overridden;
    }

    const supported = supportedLanguages.get(candidate.toLowerCase()) ?? supportedLanguages.get(normalizedCandidate);
    if (supported) {
      return supported;
    }
  }

  return undefined;
}

function normalizeLanguageKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.net/g, " net")
    .replace(/\+\+/g, "pp")
    .replace(/#/g, "sharp")
    .replace(/&/g, " and ")
    .replace(/[._\s/]+/g, "-")
    .replace(/[^a-z0-9+-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export class SyntaxHighlighter {
  public async highlight(
    code: string,
    sourcePath?: string,
    theme: SyntaxHighlightTheme = DARK_THEME
  ): Promise<HighlightedCode> {
    const language = this.languageForSourcePath(sourcePath);
    const result = await codeToTokens(code, {
      lang: language ?? PLAIN_TEXT_LANGUAGE,
      theme
    });

    return {
      lines: result.tokens.map((line) => line.map((token) => this.toHighlightedToken(token))),
      language: language ?? PLAIN_TEXT_LANGUAGE,
      highlighted: language !== undefined,
      theme
    };
  }

  public languageForSourcePath(sourcePath: string | undefined): BundledLanguage | undefined {
    if (!sourcePath) {
      return undefined;
    }

    const fileName = this.fileNameFromPath(sourcePath).toLowerCase();
    if (!fileName) {
      return undefined;
    }

    const matchedFileName = fileNameLanguages.get(fileName);
    if (matchedFileName) {
      return matchedFileName;
    }

    if (fileName.startsWith("dockerfile")) {
      return "dockerfile";
    }

    if (fileName.startsWith(".env")) {
      return "dotenv";
    }

    for (const candidate of this.extensionCandidates(fileName)) {
      const override = extensionLanguageOverrides.get(candidate);
      if (override) {
        return override;
      }

      const extensionLanguage = extensionLanguages.get(candidate);
      if (extensionLanguage) {
        return extensionLanguage;
      }

      const supportedLanguage = supportedLanguages.get(candidate);
      if (supportedLanguage) {
        return supportedLanguage;
      }
    }

    return undefined;
  }

  public themeForColorScheme(colorScheme: "dark" | "light" | "high-contrast" | undefined): SyntaxHighlightTheme {
    return colorScheme === "light" ? LIGHT_THEME : DARK_THEME;
  }

  private toHighlightedToken(token: ThemedToken): HighlightedToken {
    return {
      content: token.content,
      ...(token.color ? { color: token.color } : {}),
      ...(typeof token.fontStyle === "number" ? { fontStyle: token.fontStyle } : {})
    };
  }

  private fileNameFromPath(sourcePath: string): string {
    const cleanPath = sourcePath.split(/[?#]/, 1)[0] ?? sourcePath;
    const segments = cleanPath.split(/[\\/]/).filter(Boolean);
    return segments.at(-1) ?? "";
  }

  private extensionCandidates(fileName: string): string[] {
    const parts = fileName.split(".").filter(Boolean);
    if (parts.length <= 1) {
      return [];
    }

    const candidates: string[] = [];
    for (let index = 1; index < parts.length; index += 1) {
      candidates.push(parts.slice(index).join("."));
    }
    candidates.push(parts.at(-1) ?? "");
    return [...new Set(candidates)];
  }
}
