import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { CommandMutationGuard } from "../domain/commands/commandMutationGuard";
import { PrivacyGuard } from "../domain/privacy/privacyGuard";
import type {
  CommandExecutionOutputSnapshot,
  CommandExecutionOutputStream,
  CommandExecutionResult,
  FileGuardResult,
  GuardSummary,
  MentorCommandToolCall
} from "../domain/types";
import { WorkspacePatchApplyError, type WorkspacePatchApplyResult } from "./workspacePatchApplier";

export interface WorkspaceCommandExecutorOptions {
  readonly timeoutMs?: number;
  readonly maxOutputChars?: number;
  readonly applyPatch?: (patch: string, workingDirectory: string) => Promise<WorkspacePatchApplyResult>;
}

export interface WorkspaceCommandExecutionObserver {
  readonly onOutput?: (snapshot: CommandExecutionOutputSnapshot) => void | Promise<void>;
}

interface ProcessOutputBuffers {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class WorkspaceCommandExecutor {
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly mutationGuard = new CommandMutationGuard();
  private readonly applyPatch: WorkspaceCommandExecutorOptions["applyPatch"];

  public constructor(
    private readonly guard: PrivacyGuard,
    options: WorkspaceCommandExecutorOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxOutputChars = options.maxOutputChars ?? 80_000;
    this.applyPatch = options.applyPatch;
  }

  public async execute(
    proposal: MentorCommandToolCall,
    observer: WorkspaceCommandExecutionObserver = {}
  ): Promise<CommandExecutionResult> {
    const workingDirectory = this.resolveWorkingDirectory(proposal.workingDirectory);
    if (this.isRawPatchBody(proposal.command.trim())) {
      return this.commandResultFromPatchResult(proposal, workingDirectory, {
        files: [],
        operationCount: 0,
        message: "patch本文だけが渡されました。apply_patch コマンドとして明示してください。",
        stdout: "",
        stderr: "patch detected without explicit call to apply_patch.\n",
        exitCode: 1,
        delta: {
          changes: [],
          exact: true
        }
      });
    }
    const patchInvocation = this.applyPatchInvocation(proposal.command);
    if (patchInvocation && this.applyPatch) {
      const patchWorkingDirectory = patchInvocation.workingDirectory
        ? resolve(workingDirectory, patchInvocation.workingDirectory)
        : workingDirectory;
      return this.executeApplyPatchInvocation(proposal, patchInvocation.patch, patchWorkingDirectory, observer);
    }

    this.assertNotFileMutation(proposal);
    const buffers: ProcessOutputBuffers = {
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    };
    let progressQueue = Promise.resolve();
    const publishProgress = (activeStream: CommandExecutionOutputStream): void => {
      if (!observer.onOutput) {
        return;
      }

      const snapshot = this.outputSnapshot(proposal, workingDirectory, buffers, activeStream, false);
      progressQueue = progressQueue
        .then(() => observer.onOutput?.(snapshot))
        .then(() => undefined, () => undefined);
    };

    const processResult = await this.runProcess(proposal, workingDirectory, buffers, publishProgress);
    await progressQueue;
    const stdoutResult = this.sanitizeOutput("command-output/stdout.txt", processResult.stdout);
    const stderrResult = this.sanitizeOutput("command-output/stderr.txt", processResult.stderr);
    const safetySummary = this.combineSummary([stdoutResult.result, stderrResult.result]);

    return {
      shell: proposal.shell,
      command: proposal.command,
      workingDirectory,
      exitCode: processResult.exitCode,
      stdout: stdoutResult.content,
      stderr: stderrResult.content,
      safetySummary,
      safetyNotice: this.safetyNotice(stdoutResult.result, stderrResult.result)
    };
  }

  private async executeApplyPatchInvocation(
    proposal: MentorCommandToolCall,
    patch: string,
    workingDirectory: string,
    observer: WorkspaceCommandExecutionObserver
  ): Promise<CommandExecutionResult> {
    let patchResult: WorkspacePatchApplyResult;
    try {
      if (!this.applyPatch) {
        throw new Error("apply_patch を処理する実行環境が設定されていません。");
      }
      patchResult = await this.applyPatch(patch, workingDirectory);
    } catch (error) {
      if (error instanceof WorkspacePatchApplyError) {
        patchResult = error.result;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        patchResult = {
          files: [],
          operationCount: 0,
          message,
          stdout: "",
          stderr: `${message}\n`,
          exitCode: 1,
          delta: {
            changes: [],
            exact: true
          }
        };
      }
    }

    const result = this.commandResultFromPatchResult(proposal, workingDirectory, patchResult);
    if (observer.onOutput) {
      await observer.onOutput({
        shell: result.shell,
        command: result.command,
        workingDirectory: result.workingDirectory,
        activeStream: result.stderr.length > 0 ? "stderr" : "stdout",
        stdout: result.stdout,
        stderr: result.stderr,
        safetySummary: result.safetySummary,
        safetyNotice: result.safetyNotice,
        truncated: false
      });
    }

    return result;
  }

  private commandResultFromPatchResult(
    proposal: MentorCommandToolCall,
    workingDirectory: string,
    patchResult: WorkspacePatchApplyResult
  ): CommandExecutionResult {
    const stdoutResult = this.sanitizeOutput("command-output/apply-patch-stdout.txt", patchResult.stdout);
    const stderrResult = this.sanitizeOutput("command-output/apply-patch-stderr.txt", patchResult.stderr);
    return {
      shell: proposal.shell,
      command: proposal.command,
      workingDirectory,
      exitCode: patchResult.exitCode,
      stdout: stdoutResult.content,
      stderr: stderrResult.content,
      safetySummary: this.combineSummary([stdoutResult.result, stderrResult.result]),
      safetyNotice: this.safetyNotice(stdoutResult.result, stderrResult.result)
    };
  }

  private applyPatchInvocation(command: string): { readonly patch: string; readonly workingDirectory?: string } | undefined {
    const trimmed = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (this.isRawPatchBody(trimmed)) {
      return undefined;
    }

    const heredoc = trimmed.match(
      /^(?:(?:cd)\s+((?:'[^']+'|"[^"]+"|[^&\s]+))\s*&&\s*)?apply_?patch\s*<<\s*['"]?([A-Za-z_][A-Za-z0-9_-]*)['"]?\s*\n([\s\S]*?)\n\2\s*$/i
    );
    if (!heredoc?.[3]) {
      return undefined;
    }

    return {
      patch: heredoc[3].trimEnd(),
      ...(heredoc[1] ? { workingDirectory: this.unquoteShellWord(heredoc[1]) } : {})
    };
  }

  private isRawPatchBody(command: string): boolean {
    return command.startsWith("*** Begin Patch") && command.includes("*** End Patch");
  }

  private unquoteShellWord(value: string): string {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  private runProcess(
    proposal: MentorCommandToolCall,
    workingDirectory: string,
    buffers: ProcessOutputBuffers,
    onOutput: (activeStream: CommandExecutionOutputStream) => void
  ): Promise<ProcessResult> {
    const command = proposal.command.trim();
    if (!command) {
      throw new Error("実行コマンドが空です。");
    }

    const shell = this.shellInvocation(proposal.shell, command);
    return new Promise((resolveProcess) => {
      const child = spawn(shell.file, shell.args, {
        cwd: workingDirectory,
        windowsHide: true
      });

      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);

      const settle = (exitCode: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolveProcess({
          exitCode,
          stdout: this.outputWithTruncation(buffers.stdout, buffers.stdoutTruncated),
          stderr: this.outputWithTruncation(buffers.stderr, buffers.stderrTruncated)
        });
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        this.appendProcessOutput(buffers, "stdout", chunk.toString("utf8"));
        onOutput("stdout");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        this.appendProcessOutput(buffers, "stderr", chunk.toString("utf8"));
        onOutput("stderr");
      });

      child.on("error", (error) => {
        this.appendProcessOutput(buffers, "stderr", `${error.message}\n`);
        onOutput("stderr");
        settle(this.exitCodeFromError(error));
      });

      child.on("close", (code) => {
        if (timedOut) {
          this.appendProcessOutput(buffers, "stderr", `\n[command timed out after ${this.timeoutMs} ms]\n`);
          onOutput("stderr");
          settle(null);
          return;
        }

        settle(code);
      });
    });
  }

  private shellInvocation(shell: MentorCommandToolCall["shell"], command: string): {
    readonly file: string;
    readonly args: readonly string[];
  } {
    switch (shell) {
      case "powershell":
        return {
          file: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
        };
      case "cmd":
        return {
          file: "cmd.exe",
          args: ["/d", "/s", "/c", command]
        };
      case "bash":
        return {
          file: "bash",
          args: ["-lc", command]
        };
      default:
        throw new Error("未対応のシェルです。");
    }
  }

  private sanitizeOutput(path: string, content: string): {
    readonly content: string;
    readonly result: FileGuardResult;
  } {
    const result = this.guard.analyzeFile({
      path,
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength
    });

    if (result.blocked || result.excluded || result.maskedContent === undefined) {
      return {
        content: `[Privacy Guard blocked command output: ${result.excludeReason ?? "unsafe output"}]`,
        result
      };
    }

    return {
      content: result.maskedContent,
      result
    };
  }

  private combineSummary(results: readonly FileGuardResult[]): GuardSummary {
    return this.guard.summarize(results);
  }

  private outputSnapshot(
    proposal: MentorCommandToolCall,
    workingDirectory: string,
    buffers: ProcessOutputBuffers,
    activeStream: CommandExecutionOutputStream,
    final: boolean
  ): CommandExecutionOutputSnapshot {
    const stdoutResult = this.sanitizeOutput(
      "command-output/stdout.txt",
      this.visibleOutput(buffers.stdout, buffers.stdoutTruncated, final)
    );
    const stderrResult = this.sanitizeOutput(
      "command-output/stderr.txt",
      this.visibleOutput(buffers.stderr, buffers.stderrTruncated, final)
    );

    return {
      shell: proposal.shell,
      command: proposal.command,
      workingDirectory,
      activeStream,
      stdout: stdoutResult.content,
      stderr: stderrResult.content,
      safetySummary: this.combineSummary([stdoutResult.result, stderrResult.result]),
      safetyNotice: this.safetyNotice(stdoutResult.result, stderrResult.result),
      truncated: buffers.stdoutTruncated || buffers.stderrTruncated
    };
  }

  private safetyNotice(stdoutResult: FileGuardResult, stderrResult: FileGuardResult): string {
    const blocked = [stdoutResult, stderrResult].filter((result) => result.blocked || result.excluded);
    const maskedFindings = [stdoutResult, stderrResult].flatMap((result) => result.findings)
      .filter((finding) => finding.action === "mask").length;

    if (blocked.length > 0) {
      return `コマンド出力の一部をPrivacy Guardがブロックしました。対象: ${blocked.map((result) => result.path).join(", ")}`;
    }

    if (maskedFindings > 0) {
      return `コマンド出力はPrivacy Guardで検査済みです。${maskedFindings} 件の機密候補をマスクしました。`;
    }

    return "コマンド出力はPrivacy Guardで検査済みです。マスク対象はありません。";
  }

  private resolveWorkingDirectory(input: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("ワークスペースが開かれていません。");
    }

    const workspaceRoot = resolve(workspaceFolder.uri.fsPath);
    const trimmed = input.trim() || ".";
    const candidate = resolve(isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed));
    const relativePath = relative(workspaceRoot, candidate);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
      return candidate;
    }

    throw new Error(`作業ディレクトリはワークスペース配下に限定しています。対象: ${input}`);
  }

  private appendProcessOutput(
    buffers: ProcessOutputBuffers,
    stream: CommandExecutionOutputStream,
    chunk: string
  ): void {
    if (chunk.length === 0) {
      return;
    }

    const key = stream;
    const truncatedKey = stream === "stdout" ? "stdoutTruncated" : "stderrTruncated";
    if (buffers[key].length >= this.maxOutputChars) {
      buffers[truncatedKey] = true;
      return;
    }

    const available = this.maxOutputChars - buffers[key].length;
    if (chunk.length > available) {
      buffers[key] += chunk.slice(0, available);
      buffers[truncatedKey] = true;
      return;
    }

    buffers[key] += chunk;
  }

  private visibleOutput(value: string, truncated: boolean, final: boolean): string {
    if (final) {
      return this.outputWithTruncation(value, truncated);
    }

    const lastLineBreak = value.lastIndexOf("\n");
    if (lastLineBreak < 0) {
      return "";
    }

    const completeLines = value.slice(0, lastLineBreak + 1);
    return this.outputWithTruncation(completeLines, truncated && completeLines.length === value.length);
  }

  private outputWithTruncation(value: string, truncated: boolean): string {
    if (!truncated) {
      return value;
    }

    return `${value}\n[output truncated after ${this.maxOutputChars} chars]`;
  }

  private exitCodeFromError(error: Error | null): number | null {
    if (!error) {
      return 0;
    }

    const code = (error as NodeJS.ErrnoException & { readonly code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }

  private assertNotFileMutation(proposal: MentorCommandToolCall): void {
    const findings = this.mutationGuard.findings(proposal.command, proposal.shell);
    if (findings.length === 0) {
      return;
    }

    throw new Error([
      "ファイル書き換えに見えるコマンドは実行できません。編集は apply_patch として提案してください。",
      ...findings.map((finding) => finding.reason)
    ].join(" "));
  }
}
