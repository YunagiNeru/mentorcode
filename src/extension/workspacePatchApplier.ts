import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import {
  ApplyPatchEngine,
  ApplyPatchError,
  type AppliedPatchDelta,
  type ApplyPatchFileSystem
} from "../domain/agent/applyPatch";
import type { MentorPatchToolCall } from "../domain/types";

export interface WorkspacePatchApplyResult {
  readonly files: readonly string[];
  readonly operationCount: number;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly delta: AppliedPatchDelta;
}

export interface WorkspacePatchApplierOptions {
  readonly maxFileBytes?: number;
}

interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
}

export class WorkspacePatchApplier {
  private readonly maxFileBytes: number;
  private readonly engine = new ApplyPatchEngine();

  public constructor(options: WorkspacePatchApplierOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 120_000;
  }

  public async apply(toolCall: MentorPatchToolCall): Promise<WorkspacePatchApplyResult> {
    return this.applyPatchText(toolCall.patch, ".");
  }

  public async applyPatchText(patch: string, workingDirectory: string): Promise<WorkspacePatchApplyResult> {
    const fileSystem = this.fileSystem(workingDirectory);
    try {
      return await this.engine.apply(patch, fileSystem);
    } catch (error) {
      throw new WorkspacePatchApplyError(
        this.formatPatchError(error).message,
        this.engine.resultFromError(error)
      );
    }
  }

  private fileSystem(workingDirectory: string): ApplyPatchFileSystem {
    return {
      exists: async (path) => {
        const target = this.resolveWorkspacePath(path, workingDirectory);
        return Boolean(await this.statIfExists(target.uri));
      },
      readFile: async (path) => {
        const target = this.resolveWorkspacePath(path, workingDirectory);
        const stat = await this.statIfExists(target.uri);
        if (!stat) {
          throw new ApplyPatchError(`対象ファイルが存在しません。対象: ${target.relativePath}`, {
            path: target.relativePath,
            line: 1
          });
        }
        if (stat.type !== vscode.FileType.File) {
          throw new ApplyPatchError(`対象パスはファイルではありません。対象: ${target.relativePath}`, {
            path: target.relativePath,
            line: 1
          });
        }
        const document = await vscode.workspace.openTextDocument(target.uri);
        return document.getText();
      },
      writeFile: async (path, content) => {
        const target = this.resolveWorkspacePath(path, workingDirectory);
        this.assertContentWritable(target.relativePath, content);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(target.absolutePath)));
        await vscode.workspace.fs.writeFile(target.uri, new TextEncoder().encode(content));
      },
      deleteFile: async (path) => {
        const target = this.resolveWorkspacePath(path, workingDirectory);
        await vscode.workspace.fs.delete(target.uri, {
          recursive: false,
          useTrash: false
        });
      },
      renameFile: async (from, to) => {
        const source = this.resolveWorkspacePath(from, workingDirectory);
        const target = this.resolveWorkspacePath(to, workingDirectory);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(target.absolutePath)));
        await vscode.workspace.fs.rename(source.uri, target.uri, {
          overwrite: true
        });
      }
    };
  }

  private formatPatchError(error: unknown): Error {
    if (!(error instanceof ApplyPatchError)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    const details = [
      error.details.path ? `対象: ${error.details.path}` : "",
      error.details.hunkIndex ? `hunk: ${error.details.hunkIndex}` : "",
      error.details.line ? `推定行: ${error.details.line}` : ""
    ].filter(Boolean);
    return new Error(details.length > 0 ? `${error.message} (${details.join("、")})` : error.message);
  }

  private resolveWorkspacePath(input: string, workingDirectory = "."): ResolvedWorkspacePath {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new ApplyPatchError("ワークスペースが開かれていません。");
    }

    const workspaceRoot = resolve(workspaceFolder.uri.fsPath);
    const baseDirectory = this.resolveWorkspaceDirectory(workingDirectory, workspaceRoot);
    const trimmed = input.trim();
    if (!trimmed) {
      throw new ApplyPatchError("対象パスが空です。");
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed) || trimmed.includes("..") || trimmed.includes("\0")) {
      throw new ApplyPatchError(`安全でない相対パスです。対象: ${input}`);
    }

    const absolutePath = resolve(isAbsolute(trimmed) ? trimmed : resolve(baseDirectory, trimmed));
    const relativePath = relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new ApplyPatchError(`対象パスはワークスペース配下に限定しています。対象: ${input}`);
    }

    return {
      absolutePath,
      relativePath,
      uri: vscode.Uri.file(absolutePath)
    };
  }

  private resolveWorkspaceDirectory(input: string, workspaceRoot: string): string {
    const trimmed = input.trim() || ".";
    const candidate = resolve(isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed));
    const relativePath = relative(workspaceRoot, candidate);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      return candidate;
    }

    throw new ApplyPatchError(`作業ディレクトリはワークスペース配下に限定しています。対象: ${input}`);
  }

  private assertContentWritable(path: string, content: string): void {
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    if (sizeBytes > this.maxFileBytes) {
      throw new ApplyPatchError(`適用後ファイルサイズが上限 ${this.maxFileBytes} bytes を超えます。対象: ${path}`, {
        path,
        line: 1
      });
    }
    if (this.looksBinary(content)) {
      throw new ApplyPatchError(`バイナリの可能性がある内容は apply_patch で適用できません。対象: ${path}`, {
        path,
        line: 1
      });
    }
  }

  private looksBinary(content: string): boolean {
    if (content.length === 0) {
      return false;
    }

    const sample = content.slice(0, 4096);
    let controlCharacters = 0;
    for (const character of sample) {
      const code = character.charCodeAt(0);
      if (code === 0) {
        return true;
      }
      if (code < 8 || (code > 13 && code < 32)) {
        controlCharacters += 1;
      }
    }

    return controlCharacters / sample.length > 0.05;
  }

  private async statIfExists(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
  }
}

export class WorkspacePatchApplyError extends Error {
  public constructor(
    message: string,
    public readonly result: WorkspacePatchApplyResult
  ) {
    super(message);
  }
}
