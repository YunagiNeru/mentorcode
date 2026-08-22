import type { ContextPackage, WorkspaceMap } from "../types";

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript React"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript React"],
  [".py", "Python"],
  [".cs", "C#"],
  [".java", "Java"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".php", "PHP"],
  [".rb", "Ruby"],
  [".swift", "Swift"],
  [".kt", "Kotlin"],
  [".md", "Markdown"],
  [".json", "JSON"],
  [".yml", "YAML"],
  [".yaml", "YAML"]
]);

export class WorkspaceMapBuilder {
  public build(contextPackage: ContextPackage): WorkspaceMap {
    const languageCounts = new Map<string, number>();
    const topLevelEntries = new Set<string>();

    for (const file of contextPackage.files) {
      const normalized = file.path.replace(/\\/g, "/");
      const firstSegment = normalized.split("/").find(Boolean);
      if (firstSegment) {
        topLevelEntries.add(firstSegment);
      }

      const extension = this.extensionOf(normalized);
      const language = LANGUAGE_BY_EXTENSION.get(extension);
      if (language) {
        languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
      }
    }

    const languageHints = [...languageCounts.entries()]
      .sort((left: [string, number], right: [string, number]) => right[1] - left[1])
      .slice(0, 5)
      .map(([language, count]: [string, number]) => `${language} (${count})`);

    return {
      totalFiles: contextPackage.summary.scannedFiles,
      includedFiles: contextPackage.summary.includedFiles,
      excludedFiles: contextPackage.summary.blockedFiles,
      languageHints,
      topLevelEntries: [...topLevelEntries].sort().slice(0, 20)
    };
  }

  private extensionOf(path: string): string {
    const lastDot = path.lastIndexOf(".");
    if (lastDot < 0) {
      return "";
    }

    return path.slice(lastDot).toLowerCase();
  }
}
