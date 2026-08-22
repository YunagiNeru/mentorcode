import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

describe("Codex-style patch architecture", () => {
  it("does not reintroduce the old Add File existing-file rejection", async () => {
    const content = await source("src/domain/agent/applyPatch.ts");

    expect(content).not.toContain("追加対象ファイルは既に存在します");
    expect(content).toContain("overwrittenContent");
  });

  it("does not rollback committed patch operations in the workspace applier", async () => {
    const content = await source("src/extension/workspacePatchApplier.ts");

    expect(content).not.toContain("rollback(");
    expect(content).not.toContain("FileSnapshot");
    expect(content).toContain("WorkspacePatchApplyError");
  });

  it("keeps command heredoc apply_patch on the patch runtime path", async () => {
    const content = await source("src/extension/workspaceCommandExecutor.ts");

    expect(content).toContain("applyPatchInvocation");
    expect(content).toContain("patch detected without explicit call to apply_patch");
    expect(content.indexOf("applyPatchInvocation")).toBeLessThan(content.indexOf("assertNotFileMutation"));
  });
});
