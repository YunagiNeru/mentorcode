import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Uri, workspace } from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandExecutionOutputSnapshot, MentorCommandToolCall } from "../src/domain/types";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { WorkspaceCommandExecutor } from "../src/extension/workspaceCommandExecutor";
import { WorkspacePatchApplier } from "../src/extension/workspacePatchApplier";

const tempRoots: string[] = [];

async function createWorkspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mentor-code-command-"));
  tempRoots.push(root);
  (workspace as unknown as {
    workspaceFolders: { readonly uri: Uri; readonly name: string; readonly index: number }[];
  }).workspaceFolders = [
    {
      uri: Uri.file(root),
      name: "project",
      index: 0
    }
  ];
  return root;
}

function streamingProposal(secret: string): MentorCommandToolCall {
  if (process.platform === "win32") {
    return {
      type: "run_command",
      shell: "cmd",
      command: `echo visible-output&&echo apiKey=${secret}&&echo error-output 1>&2`,
      workingDirectory: ".",
      meaning: "標準出力と標準エラーの逐次表示を確認します。",
      expectedResult: "標準出力と標準エラーが取得されます。"
    };
  }

  return {
    type: "run_command",
    shell: "bash",
    command: `printf 'visible-output\\n'; printf 'apiKey=${secret}\\n'; printf 'error-output\\n' >&2`,
    workingDirectory: ".",
    meaning: "標準出力と標準エラーの逐次表示を確認します。",
    expectedResult: "標準出力と標準エラーが取得されます。"
  };
}

afterEach(async () => {
  (workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [];
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceCommandExecutor", () => {
  it("publishes privacy-guarded output snapshots while a command is running", async () => {
    await createWorkspaceRoot();
    const guard = new PrivacyGuard();
    const executor = new WorkspaceCommandExecutor(guard, { timeoutMs: 10_000 });
    const secret = "sk-test_abcdefghijklmnopqrstuvwxyz1234567890";
    const snapshots: CommandExecutionOutputSnapshot[] = [];

    const result = await executor.execute(streamingProposal(secret), {
      onOutput: (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    const combinedSnapshots = snapshots.map((snapshot) => `${snapshot.stdout}\n${snapshot.stderr}`).join("\n");

    expect(result.exitCode).toBe(0);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(combinedSnapshots).toContain("visible-output");
    expect(combinedSnapshots).toContain("__OPENAI_API_KEY_");
    expect(combinedSnapshots).not.toContain(secret);
    expect(result.stdout).toContain("visible-output");
    expect(result.stdout).toContain("__OPENAI_API_KEY_");
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).toContain("error-output");
  });

  it("rejects direct file mutation commands before execution", async () => {
    await createWorkspaceRoot();
    const executor = new WorkspaceCommandExecutor(new PrivacyGuard(), { timeoutMs: 10_000 });

    await expect(executor.execute({
      type: "run_command",
      shell: "powershell",
      command: "\"value\" | Set-Content app.properties",
      workingDirectory: ".",
      meaning: "ファイルを書き換えます。",
      expectedResult: "ファイルが更新されます。"
    })).rejects.toThrow("ファイル書き換えに見えるコマンド");
  });

  it("intercepts apply_patch heredoc commands before mutation guarding", async () => {
    const root = await createWorkspaceRoot();
    const patchApplier = new WorkspacePatchApplier();
    const executor = new WorkspaceCommandExecutor(new PrivacyGuard(), {
      timeoutMs: 10_000,
      applyPatch: (patch, workingDirectory) => patchApplier.applyPatchText(patch, workingDirectory)
    });
    const snapshots: CommandExecutionOutputSnapshot[] = [];

    const result = await executor.execute({
      type: "run_command",
      shell: "bash",
      command: [
        "apply_patch <<'PATCH'",
        "*** Begin Patch",
        "*** Add File: pom.xml",
        "+<project>",
        "+</project>",
        "*** End Patch",
        "PATCH"
      ].join("\n"),
      workingDirectory: ".",
      meaning: "apply_patchでMaven構成を作成します。",
      expectedResult: "pom.xml が作成されます。"
    }, {
      onOutput: (snapshot) => {
        snapshots.push(snapshot);
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("編集案を 1 件");
    expect(snapshots).toHaveLength(1);
    await expect(readFile(join(root, "pom.xml"), "utf8")).resolves.toBe("<project>\n</project>\n");
  });

  it("uses the heredoc cd directory as the effective patch working directory", async () => {
    const root = await createWorkspaceRoot();
    await mkdir(join(root, "backend"), { recursive: true });
    const patchApplier = new WorkspacePatchApplier();
    const executor = new WorkspaceCommandExecutor(new PrivacyGuard(), {
      timeoutMs: 10_000,
      applyPatch: (patch, workingDirectory) => patchApplier.applyPatchText(patch, workingDirectory)
    });

    const result = await executor.execute({
      type: "run_command",
      shell: "powershell",
      command: [
        "cd backend && apply_patch <<'PATCH'",
        "*** Begin Patch",
        "*** Add File: application.properties",
        "+server.port=3001",
        "*** End Patch",
        "PATCH"
      ].join("\n"),
      workingDirectory: ".",
      meaning: "backend配下に設定を作成します。",
      expectedResult: "application.properties が作成されます。"
    });

    expect(result.exitCode).toBe(0);
    await expect(readFile(join(root, "backend", "application.properties"), "utf8")).resolves.toBe("server.port=3001\n");
  });

  it("returns a command result instead of executing a raw patch body", async () => {
    const root = await createWorkspaceRoot();
    const executor = new WorkspaceCommandExecutor(new PrivacyGuard(), { timeoutMs: 10_000 });

    const result = await executor.execute({
      type: "run_command",
      shell: "bash",
      command: [
        "*** Begin Patch",
        "*** Add File: should-not-exist.txt",
        "+blocked",
        "*** End Patch"
      ].join("\n"),
      workingDirectory: ".",
      meaning: "raw patchは実行しません。",
      expectedResult: "失敗結果になります。"
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("apply_patch");
    await expect(readFile(join(root, "should-not-exist.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
