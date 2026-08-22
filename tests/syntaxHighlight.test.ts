import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledThemes } from "shiki/bundle/full";
import { SyntaxHighlighter } from "../src/webview/syntaxHighlight";

function textFromLines(lines: Awaited<ReturnType<SyntaxHighlighter["highlight"]>>["lines"]): string {
  return lines.map((line) => line.map((token) => token.content).join("")).join("\n");
}

function hasColoredToken(result: Awaited<ReturnType<SyntaxHighlighter["highlight"]>>): boolean {
  return result.lines.some((line) => line.some((token) => typeof token.color === "string" && token.color.length > 0));
}

function colorClassSuffix(color: string): string {
  return color.toLowerCase().replace(/[^a-f0-9]/g, "");
}

async function tokenColorsForTheme(themeName: "dark-plus" | "light-plus"): Promise<string[]> {
  const themeModule = await bundledThemes[themeName]();
  const theme = themeModule.default;
  const semanticTokenColors = theme.semanticTokenColors as
    | Record<string, string | { readonly foreground?: string }>
    | undefined;
  const colors = new Set<string>();

  for (const tokenColor of theme.tokenColors ?? []) {
    const foreground = tokenColor.settings?.foreground;
    if (foreground) {
      colors.add(foreground);
    }
  }

  for (const semanticColor of Object.values(semanticTokenColors ?? {})) {
    if (typeof semanticColor === "string") {
      colors.add(semanticColor);
    } else if (semanticColor && typeof semanticColor === "object" && "foreground" in semanticColor) {
      const foreground = semanticColor.foreground;
      if (typeof foreground === "string") {
        colors.add(foreground);
      }
    }
  }

  return [...colors];
}

describe("SyntaxHighlighter", () => {
  it("resolves languages from file paths and well-known special files", () => {
    const highlighter = new SyntaxHighlighter();

    expect(highlighter.languageForSourcePath("backend/src/index.ts")).toBe("typescript");
    expect(highlighter.languageForSourcePath("backend/src/App.tsx")).toBe("tsx");
    expect(highlighter.languageForSourcePath("backend/package.json")).toBe("json");
    expect(highlighter.languageForSourcePath("backend/tsconfig.json")).toBe("jsonc");
    expect(highlighter.languageForSourcePath("backend/.env")).toBe("dotenv");
    expect(highlighter.languageForSourcePath("backend/.env.local")).toBe("dotenv");
    expect(highlighter.languageForSourcePath("backend/prisma/schema.prisma")).toBe("prisma");
    expect(highlighter.languageForSourcePath("pom.xml")).toBe("xml");
    expect(highlighter.languageForSourcePath("src/main/resources/application.properties")).toBe("ini");
    expect(highlighter.languageForSourcePath("src/main/java/com/example/App.java")).toBe("java");
    expect(highlighter.languageForSourcePath("Dockerfile.dev")).toBe("dockerfile");
    expect(highlighter.languageForSourcePath("include/task.hpp")).toBe("cpp");
    expect(highlighter.languageForSourcePath("src/Program.cs")).toBe("csharp");
    expect(highlighter.languageForSourcePath("src/App.fs")).toBe("fsharp");
    expect(highlighter.languageForSourcePath("README.rst")).toBe("rst");
  });

  it("highlights TypeScript while preserving the source text", async () => {
    const highlighter = new SyntaxHighlighter();
    const code = "const answer = 42;\n";
    const result = await highlighter.highlight(code, "src/index.ts", "dark-plus");

    expect(result.language).toBe("typescript");
    expect(result.highlighted).toBe(true);
    expect(hasColoredToken(result)).toBe(true);
    expect(textFromLines(result.lines)).toBe(code);
  });

  it("highlights XML, properties, and Java snippets with Shiki tokens", async () => {
    const highlighter = new SyntaxHighlighter();

    const xml = await highlighter.highlight("<project><modelVersion>4.0.0</modelVersion></project>", "pom.xml", "dark-plus");
    const properties = await highlighter.highlight("spring.application.name=task-manager", "application.properties", "dark-plus");
    const java = await highlighter.highlight("public class TaskManagerApplication {}", "TaskManagerApplication.java", "dark-plus");

    expect(xml.language).toBe("xml");
    expect(properties.language).toBe("ini");
    expect(java.language).toBe("java");
    expect(hasColoredToken(xml)).toBe(true);
    expect(hasColoredToken(properties)).toBe(true);
    expect(hasColoredToken(java)).toBe(true);
  });

  it("keeps html-like source text as token content instead of executable markup", async () => {
    const highlighter = new SyntaxHighlighter();
    const code = "const tag = '<script>';";
    const result = await highlighter.highlight(code, "src/index.ts", "dark-plus");

    expect(textFromLines(result.lines)).toBe(code);
  });

  it("falls back to plain text for unknown extensions", async () => {
    const highlighter = new SyntaxHighlighter();
    const code = "function run() { return 1; }";
    const result = await highlighter.highlight(code, "source.unknown_ext", "dark-plus");

    expect(result.language).toBe("text");
    expect(result.highlighted).toBe(false);
    expect(textFromLines(result.lines)).toBe(code);
  });

  it("keeps stylesheet classes in sync with Shiki theme colors", async () => {
    const styles = readFileSync(resolve(process.cwd(), "src", "webview", "styles.css"), "utf-8");
    const colors = [
      ...await tokenColorsForTheme("dark-plus"),
      ...await tokenColorsForTheme("light-plus")
    ];

    for (const color of colors) {
      expect(styles).toContain(`.code-preview .shiki-fg-${colorClassSuffix(color)}`);
    }
  });
});
