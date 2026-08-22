import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Uri, workspace } from "vscode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePatchApplier } from "../src/extension/workspacePatchApplier";

let tempRoot: string | undefined;

function setWorkspaceFolders(folders: { readonly uri: Uri; readonly name: string; readonly index: number }[]): void {
  (workspace as unknown as { workspaceFolders: typeof folders }).workspaceFolders = folders;
}

async function createTempWorkspace(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), "mentor-patch-"));
  setWorkspaceFolders([
    {
      uri: Uri.file(tempRoot),
      name: "workspace",
      index: 0
    }
  ]);
  return tempRoot;
}

function patchToolCall(patch: string, intent = "patchを適用します。") {
  return {
    type: "apply_patch" as const,
    intent,
    patch
  };
}

describe("WorkspacePatchApplier", () => {
  beforeEach(async () => {
    await createTempWorkspace();
  });

  afterEach(async () => {
    setWorkspaceFolders([]);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("overwrites existing files from Add File patches and records overwritten content", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await writeFile(join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n", "utf8");

    const result = await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Add File: tsconfig.json",
      "+{",
      "+  \"compilerOptions\": {",
      "+    \"strict\": true",
      "+  }",
      "+}",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "tsconfig.json"), "utf8")).resolves.toBe([
      "{",
      "  \"compilerOptions\": {",
      "    \"strict\": true",
      "  }",
      "}",
      ""
    ].join("\n"));
    expect(result.files).toEqual(["tsconfig.json"]);
    expect(result.exitCode).toBe(0);
    expect(result.delta.changes[0]).toMatchObject({
      path: "tsconfig.json",
      change: {
        type: "add",
        overwrittenContent: "{\"compilerOptions\":{}}\n"
      }
    });
  });

  it("applies line-based Update File patches to environment files", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await mkdir(join(root, "backend"), { recursive: true });
    await writeFile(join(root, "backend", ".env"), "PORT=3000\nDATABASE_URL=old\n", "utf8");

    const result = await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Update File: backend/.env",
      "@@",
      "-PORT=3000",
      "+PORT=3001",
      " DATABASE_URL=old",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "backend", ".env"), "utf8")).resolves.toBe("PORT=3001\nDATABASE_URL=old\n");
    expect(result.files).toEqual(["backend/.env"]);
  });

  it("matches hunks with trailing and leading whitespace differences", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await writeFile(join(root, "App.java"), "class App {\n    String value = \"old\";   \n}\n", "utf8");

    await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Update File: App.java",
      "@@",
      " class App {",
      "-String value = \"old\";",
      "+String value = \"new\";",
      " }",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "App.java"), "utf8")).resolves.toBe("class App {\nString value = \"new\";\n}\n");
  });

  it("accepts standard unified diff range headers without treating them as context text", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await writeFile(join(root, "settings.gradle"), "rootProject.name = 'old'\n", "utf8");

    await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Update File: settings.gradle",
      "@@ -1 +1 @@",
      "-rootProject.name = 'old'",
      "+rootProject.name = 'new'",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "settings.gradle"), "utf8")).resolves.toBe("rootProject.name = 'new'\n");
  });

  it("supports explicit end-of-file insertion hunks", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await writeFile(join(root, "notes.txt"), "first\n", "utf8");

    await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Update File: notes.txt",
      "@@",
      "+second",
      "*** End of File",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "notes.txt"), "utf8")).resolves.toBe("first\nsecond\n");
  });

  it("reports stale hunk failures with file, hunk, and line without changing that file", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await mkdir(join(root, "backend"), { recursive: true });
    await writeFile(join(root, "backend", ".env"), "PORT=3001\nDATABASE_URL=current\n", "utf8");

    await expect(new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Update File: backend/.env",
      "@@",
      "-PORT=3000",
      "+PORT=3002",
      "*** End Patch"
    ].join("\n")))).rejects.toThrow(/backend\/\.env.*hunk: 1.*推定行: 1/);

    await expect(readFile(join(root, "backend", ".env"), "utf8")).resolves.toBe("PORT=3001\nDATABASE_URL=current\n");
  });

  it("creates local environment files from Add File patches", async () => {
    const root = tempRoot ?? await createTempWorkspace();

    const result = await new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Add File: backend/.env",
      "+DATABASE_URL=postgresql://app:app@localhost:5432/app",
      "+PORT=3001",
      "*** End Patch"
    ].join("\n")));

    await expect(readFile(join(root, "backend", ".env"), "utf8")).resolves.toContain("DATABASE_URL=");
    expect(result.files).toEqual(["backend/.env"]);
  });

  it("keeps committed earlier operations when a later operation fails and exposes the delta", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "index.ts"), "console.log('delete me');\n", "utf8");

    await expect(new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Delete File: src/index.ts",
      "*** Update File: src/missing.ts",
      "@@",
      "-missing",
      "+updated",
      "*** End Patch"
    ].join("\n")))).rejects.toMatchObject({
      result: {
        exitCode: 1,
        files: ["src/index.ts", "src/missing.ts"],
        delta: {
          exact: false,
          changes: [
            {
              path: "src/index.ts",
              change: {
                type: "delete",
                content: "console.log('delete me');\n"
              }
            }
          ]
        }
      }
    });

    await expect(stat(join(root, "src", "index.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies patches relative to an approved command working directory", async () => {
    const root = tempRoot ?? await createTempWorkspace();
    await mkdir(join(root, "backend"), { recursive: true });

    await new WorkspacePatchApplier().applyPatchText([
      "*** Begin Patch",
      "*** Add File: app.properties",
      "+server.port=3001",
      "*** End Patch"
    ].join("\n"), "backend");

    await expect(readFile(join(root, "backend", "app.properties"), "utf8")).resolves.toBe("server.port=3001\n");
  });

  it("rejects unsafe paths before writing outside the workspace", async () => {
    await expect(new WorkspacePatchApplier().apply(patchToolCall([
      "*** Begin Patch",
      "*** Add File: ../unsafe.ts",
      "+export const value = 1;",
      "*** End Patch"
    ].join("\n")))).rejects.toThrow("安全でない相対パス");
  });
});
