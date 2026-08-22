import { describe, expect, it } from "vitest";
import { filterMentionedReferences, splitWorkspaceFileMentions } from "../src/webview/referenceMentions";

describe("filterMentionedReferences", () => {
  it("keeps selected references that still appear in the composer text", () => {
    const references = [
      { path: "src/main.ts" },
      { path: "src/server/app.ts" }
    ];

    expect(filterMentionedReferences(references, "確認して @src/main.ts ")).toEqual([
      { path: "src/main.ts" }
    ]);
  });

  it("removes stale selected references after the @ mention is deleted", () => {
    const references = [
      { path: "src/main.ts" }
    ];

    expect(filterMentionedReferences(references, "確認して")).toEqual([]);
  });
});

describe("splitWorkspaceFileMentions", () => {
  it("detects standalone workspace filenames", () => {
    expect(splitWorkspaceFileMentions("PostgreSQL 起動用の docker-compose.yml を作成します。")).toEqual([
      { text: "PostgreSQL 起動用の " },
      { text: "docker-compose.yml", filePath: "docker-compose.yml" },
      { text: " を作成します。" }
    ]);
  });

  it("detects relative paths and normalizes backslashes", () => {
    expect(splitWorkspaceFileMentions("ファイル作成: frontend\\src\\App.tsx")).toEqual([
      { text: "ファイル作成: " },
      { text: "frontend\\src\\App.tsx", filePath: "frontend/src/App.tsx" }
    ]);
  });

  it("keeps the @ prefix visible while using the normalized target path", () => {
    expect(splitWorkspaceFileMentions("確認して @src/webview/main.ts ")).toEqual([
      { text: "確認して " },
      { text: "@src/webview/main.ts", filePath: "src/webview/main.ts" },
      { text: " " }
    ]);
  });

  it("detects comma-separated workspace filenames", () => {
    expect(splitWorkspaceFileMentions("対象: pom.xml, application.properties, TaskManagementApplication.java")).toEqual([
      { text: "対象: " },
      { text: "pom.xml", filePath: "pom.xml" },
      { text: ", " },
      { text: "application.properties", filePath: "application.properties" },
      { text: ", " },
      { text: "TaskManagementApplication.java", filePath: "TaskManagementApplication.java" }
    ]);
  });

  it("does not link URLs or extensionless API paths", () => {
    expect(splitWorkspaceFileMentions("https://example.com, と `/api/health` を確認します。")).toEqual([
      { text: "https://example.com, と `/api/health` を確認します。" }
    ]);
  });
});
