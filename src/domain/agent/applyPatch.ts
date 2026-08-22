export type ApplyPatchAction =
  | {
    readonly type: "add";
    readonly path: string;
    readonly content: string;
  }
  | {
    readonly type: "delete";
    readonly path: string;
  }
  | {
    readonly type: "update";
    readonly path: string;
    readonly moveTo?: string;
    readonly hunks: readonly ApplyPatchHunk[];
  };

export interface ApplyPatchHunk {
  readonly index: number;
  readonly context?: string;
  readonly isEndOfFile: boolean;
  readonly lines: readonly ApplyPatchLine[];
}

export type ApplyPatchLine =
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "remove"; readonly text: string }
  | { readonly kind: "add"; readonly text: string };

export interface ParsedApplyPatch {
  readonly actions: readonly ApplyPatchAction[];
}

export interface ApplyPatchFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export type AppliedPatchFileChange =
  | {
    readonly type: "add";
    readonly content: string;
    readonly overwrittenContent?: string;
  }
  | {
    readonly type: "delete";
    readonly content: string;
  }
  | {
    readonly type: "update";
    readonly moveTo?: string;
    readonly oldContent: string;
    readonly overwrittenMoveContent?: string;
    readonly newContent: string;
  };

export interface AppliedPatchChange {
  readonly path: string;
  readonly change: AppliedPatchFileChange;
}

export interface AppliedPatchDelta {
  readonly changes: readonly AppliedPatchChange[];
  readonly exact: boolean;
}

export interface ApplyPatchResult {
  readonly files: readonly string[];
  readonly operationCount: number;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly delta: AppliedPatchDelta;
}

export class ApplyPatchError extends Error {
  public constructor(
    message: string,
    public readonly details: {
      readonly path?: string;
      readonly hunkIndex?: number;
      readonly line?: number;
    } = {},
    public readonly delta: AppliedPatchDelta = emptyAppliedPatchDelta()
  ) {
    super(message);
  }
}

interface MutableAppliedPatchDelta {
  changes: AppliedPatchChange[];
  exact: boolean;
}

interface Replacement {
  readonly index: number;
  readonly oldLength: number;
  readonly newLines: readonly string[];
}

export function emptyAppliedPatchDelta(): AppliedPatchDelta {
  return {
    changes: [],
    exact: true
  };
}

export class ApplyPatchParser {
  public parse(patch: string): ParsedApplyPatch {
    const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (lines[0] !== "*** Begin Patch") {
      throw new ApplyPatchError("apply_patch は *** Begin Patch で開始する必要があります。");
    }
    if (!lines.includes("*** End Patch")) {
      throw new ApplyPatchError("apply_patch は *** End Patch で終了する必要があります。");
    }

    const actions: ApplyPatchAction[] = [];
    let index = 1;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "*** End Patch") {
        return { actions };
      }

      if (line.startsWith("*** Add File: ")) {
        const path = this.pathAfter(line, "*** Add File: ");
        const contentLines: string[] = [];
        index += 1;
        while (index < lines.length && !this.isActionBoundary(lines[index] ?? "")) {
          const current = lines[index] ?? "";
          if (!current.startsWith("+")) {
            throw new ApplyPatchError(
              `追加ファイルの本文行は + で始める必要があります。対象: ${path}`,
              { path }
            );
          }
          contentLines.push(current.slice(1));
          index += 1;
        }
        actions.push({
          type: "add",
          path,
          content: this.joinPatchContent(contentLines)
        });
        continue;
      }

      if (line.startsWith("*** Delete File: ")) {
        actions.push({
          type: "delete",
          path: this.pathAfter(line, "*** Delete File: ")
        });
        index += 1;
        continue;
      }

      if (line.startsWith("*** Update File: ")) {
        const path = this.pathAfter(line, "*** Update File: ");
        index += 1;
        let moveTo: string | undefined;
        if ((lines[index] ?? "").startsWith("*** Move to: ")) {
          moveTo = this.pathAfter(lines[index] ?? "", "*** Move to: ");
          index += 1;
        }

        const hunks: ApplyPatchHunk[] = [];
        let currentContext: string | undefined;
        let currentHunkLines: ApplyPatchLine[] = [];
        let currentHunkEndsAtEof = false;
        const flushHunk = (): void => {
          if (currentHunkLines.length === 0 && !currentContext && !currentHunkEndsAtEof) {
            return;
          }
          hunks.push({
            index: hunks.length + 1,
            ...(currentContext ? { context: currentContext } : {}),
            isEndOfFile: currentHunkEndsAtEof,
            lines: currentHunkLines
          });
          currentContext = undefined;
          currentHunkLines = [];
          currentHunkEndsAtEof = false;
        };

        while (index < lines.length && !this.isActionBoundary(lines[index] ?? "")) {
          const current = lines[index] ?? "";
          if (current.startsWith("@@")) {
            flushHunk();
            currentContext = this.contextFromHeader(current);
            index += 1;
            continue;
          }
          if (current === "*** End of File") {
            currentHunkEndsAtEof = true;
            index += 1;
            continue;
          }
          if (current.startsWith(" ")) {
            currentHunkLines.push({ kind: "context", text: current.slice(1) });
            index += 1;
            continue;
          }
          if (current.startsWith("-")) {
            currentHunkLines.push({ kind: "remove", text: current.slice(1) });
            index += 1;
            continue;
          }
          if (current.startsWith("+")) {
            currentHunkLines.push({ kind: "add", text: current.slice(1) });
            index += 1;
            continue;
          }
          if (current === "\\ No newline at end of file") {
            index += 1;
            continue;
          }
          throw new ApplyPatchError(
            `更新 hunk の行は 空白 / - / + / @@ / *** End of File のいずれかで始める必要があります。対象: ${path}`,
            { path, hunkIndex: hunks.length + 1 }
          );
        }
        flushHunk();
        if (hunks.length === 0 && !moveTo) {
          throw new ApplyPatchError(`更新内容が空です。対象: ${path}`, { path });
        }
        actions.push({
          type: "update",
          path,
          ...(moveTo ? { moveTo } : {}),
          hunks
        });
        continue;
      }

      if (line.trim().length === 0) {
        index += 1;
        continue;
      }

      throw new ApplyPatchError(`未対応の apply_patch 行です: ${line}`);
    }

    throw new ApplyPatchError("apply_patch の末尾に *** End Patch がありません。");
  }

  private isActionBoundary(line: string): boolean {
    return line === "*** End Patch" ||
      line.startsWith("*** Add File: ") ||
      line.startsWith("*** Update File: ") ||
      line.startsWith("*** Delete File: ");
  }

  private pathAfter(line: string, prefix: string): string {
    const path = line.slice(prefix.length).trim();
    if (!path) {
      throw new ApplyPatchError(`${prefix.trim()} の対象パスが空です。`);
    }
    return path;
  }

  private contextFromHeader(line: string): string | undefined {
    const raw = line.replace(/^@@\s*/, "").replace(/\s*@@$/, "").trim();
    if (/^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?$/.test(raw)) {
      return undefined;
    }
    return raw.length > 0 ? raw : undefined;
  }

  private joinPatchContent(lines: readonly string[]): string {
    if (lines.length === 0) {
      return "";
    }
    return lines.join("\n") + "\n";
  }
}

export class ApplyPatchEngine {
  private readonly parser = new ApplyPatchParser();

  public async apply(patch: string, fileSystem: ApplyPatchFileSystem): Promise<ApplyPatchResult> {
    const parsed = this.parser.parse(patch);
    const delta: MutableAppliedPatchDelta = {
      changes: [],
      exact: true
    };
    if (parsed.actions.length === 0) {
      throw new ApplyPatchError("apply_patch に操作が含まれていません。", {}, this.snapshotDelta(delta));
    }

    const touchedPaths = new Set<string>();
    for (const action of parsed.actions) {
      try {
        switch (action.type) {
          case "add":
            await this.applyAdd(action, fileSystem, delta);
            touchedPaths.add(action.path);
            break;
          case "delete":
            await this.applyDelete(action, fileSystem, delta);
            touchedPaths.add(action.path);
            break;
          case "update":
            await this.applyUpdate(action, fileSystem, delta);
            touchedPaths.add(action.path);
            if (action.moveTo) {
              touchedPaths.add(action.moveTo);
            }
            break;
        }
      } catch (error) {
        throw this.withDelta(error, delta);
      }
    }

    const resultDelta = this.snapshotDelta(delta);
    const message = this.summaryMessage(parsed.actions.length, resultDelta, undefined);
    return {
      files: [...touchedPaths],
      operationCount: parsed.actions.length,
      message,
      stdout: `${message}\n`,
      stderr: "",
      exitCode: 0,
      delta: resultDelta
    };
  }

  public resultFromError(error: unknown): ApplyPatchResult {
    const patchError = error instanceof ApplyPatchError
      ? error
      : new ApplyPatchError(error instanceof Error ? error.message : String(error));
    const files = this.pathsFromDelta(patchError.delta, patchError.details.path);
    const message = this.summaryMessage(patchError.delta.changes.length, patchError.delta, patchError.message);
    return {
      files,
      operationCount: patchError.delta.changes.length,
      message,
      stdout: patchError.delta.changes.length > 0
        ? `部分的に ${patchError.delta.changes.length} 件のパッチ操作を適用しました。\n`
        : "",
      stderr: `${patchError.message}\n`,
      exitCode: 1,
      delta: patchError.delta
    };
  }

  private async applyAdd(
    action: Extract<ApplyPatchAction, { readonly type: "add" }>,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta
  ): Promise<void> {
    const overwrittenContent = await this.readOptional(action.path, fileSystem, delta);
    await this.tryWrite(action.path, action.content, fileSystem, delta);
    delta.changes.push({
      path: action.path,
      change: {
        type: "add",
        content: action.content,
        ...(overwrittenContent !== undefined ? { overwrittenContent } : {})
      }
    });
  }

  private async applyDelete(
    action: Extract<ApplyPatchAction, { readonly type: "delete" }>,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta
  ): Promise<void> {
    const deletedContent = await this.readRequired(action.path, fileSystem, delta, "削除");
    await fileSystem.deleteFile(action.path);
    delta.changes.push({
      path: action.path,
      change: {
        type: "delete",
        content: deletedContent
      }
    });
  }

  private async applyUpdate(
    action: Extract<ApplyPatchAction, { readonly type: "update" }>,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta
  ): Promise<void> {
    const originalContent = await this.readRequired(action.path, fileSystem, delta, "更新");
    const updatedContent = this.applyHunks(action, originalContent);
    if (action.moveTo) {
      const overwrittenMoveContent = await this.readOptional(action.moveTo, fileSystem, delta);
      await this.tryWrite(action.moveTo, updatedContent, fileSystem, delta);
      try {
        await fileSystem.deleteFile(action.path);
      } catch (error) {
        delta.changes.push({
          path: action.moveTo,
          change: {
            type: "add",
            content: updatedContent,
            ...(overwrittenMoveContent !== undefined ? { overwrittenContent: overwrittenMoveContent } : {})
          }
        });
        throw error;
      }
      delta.changes.push({
        path: action.path,
        change: {
          type: "update",
          moveTo: action.moveTo,
          oldContent: originalContent,
          ...(overwrittenMoveContent !== undefined ? { overwrittenMoveContent } : {}),
          newContent: updatedContent
        }
      });
      return;
    }

    await this.tryWrite(action.path, updatedContent, fileSystem, delta);
    delta.changes.push({
      path: action.path,
      change: {
        type: "update",
        oldContent: originalContent,
        newContent: updatedContent
      }
    });
  }

  private async readRequired(
    path: string,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta,
    label: string
  ): Promise<string> {
    try {
      return await fileSystem.readFile(path);
    } catch (error) {
      delta.exact = false;
      const detail = error instanceof Error ? error.message : String(error);
      throw new ApplyPatchError(
        `${label}対象ファイルが存在しないか読み取れません。対象: ${path}${detail ? `。${detail}` : ""}`,
        { path, line: 1 },
        this.snapshotDelta(delta)
      );
    }
  }

  private async readOptional(
    path: string,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta
  ): Promise<string | undefined> {
    if (!await fileSystem.exists(path)) {
      return undefined;
    }
    try {
      return await fileSystem.readFile(path);
    } catch {
      delta.exact = false;
      return undefined;
    }
  }

  private async tryWrite(
    path: string,
    content: string,
    fileSystem: ApplyPatchFileSystem,
    delta: MutableAppliedPatchDelta
  ): Promise<void> {
    try {
      await fileSystem.writeFile(path, content);
    } catch (error) {
      delta.exact = false;
      throw error;
    }
  }

  private applyHunks(
    action: Extract<ApplyPatchAction, { readonly type: "update" }>,
    content: string
  ): string {
    const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
    let lines = this.splitContentLines(content);
    let searchStart = 0;
    const replacements: Replacement[] = [];

    for (const hunk of action.hunks) {
      if (hunk.context) {
        const contextIndex = seekSequence(lines, [hunk.context], searchStart, false);
        if (contextIndex === undefined) {
          throw new ApplyPatchError(
            `patch context が現在のファイル内容に一致しません。対象: ${action.path}、hunk: ${hunk.index}`,
            {
              path: action.path,
              hunkIndex: hunk.index,
              line: searchStart + 1
            }
          );
        }
        searchStart = contextIndex + 1;
      }

      const oldLines = hunk.lines
        .filter((line) => line.kind !== "add")
        .map((line) => line.text);
      const newLines = hunk.lines
        .filter((line) => line.kind !== "remove")
        .map((line) => line.text);
      if (oldLines.length === 0) {
        const insertionIndex = hunk.isEndOfFile ? lines.length : Math.min(searchStart, lines.length);
        replacements.push({
          index: insertionIndex,
          oldLength: 0,
          newLines
        });
        searchStart = insertionIndex + newLines.length;
        continue;
      }

      const match = this.findOldLines(lines, oldLines, searchStart, hunk.isEndOfFile);
      if (!match) {
        throw new ApplyPatchError(
          `patch hunk が現在のファイル内容に一致しません。対象: ${action.path}、hunk: ${hunk.index}`,
          {
            path: action.path,
            hunkIndex: hunk.index,
            line: searchStart + 1
          }
        );
      }
      replacements.push({
        index: match.index,
        oldLength: match.oldLength,
        newLines
      });
      searchStart = match.index + match.oldLength;
    }

    for (const replacement of [...replacements].sort((left, right) => right.index - left.index)) {
      lines = [
        ...lines.slice(0, replacement.index),
        ...replacement.newLines,
        ...lines.slice(replacement.index + replacement.oldLength)
      ];
    }

    return this.joinContentLines(lines, lineEnding, content.endsWith("\n") || lines.length > 0);
  }

  private findOldLines(
    lines: readonly string[],
    oldLines: readonly string[],
    searchStart: number,
    eof: boolean
  ): { readonly index: number; readonly oldLength: number } | undefined {
    const directIndex = seekSequence(lines, oldLines, searchStart, eof);
    if (directIndex !== undefined) {
      return {
        index: directIndex,
        oldLength: oldLines.length
      };
    }

    if (oldLines.length > 0 && oldLines.at(-1) === "") {
      const trimmedPattern = oldLines.slice(0, -1);
      const trimmedIndex = seekSequence(lines, trimmedPattern, searchStart, eof);
      if (trimmedIndex !== undefined) {
        return {
          index: trimmedIndex,
          oldLength: trimmedPattern.length
        };
      }
    }

    return undefined;
  }

  private splitContentLines(content: string): string[] {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (normalized.endsWith("\n")) {
      return lines.slice(0, -1);
    }
    return lines;
  }

  private joinContentLines(lines: readonly string[], lineEnding: string, finalNewline: boolean): string {
    return `${lines.join(lineEnding)}${finalNewline ? lineEnding : ""}`;
  }

  private withDelta(error: unknown, delta: MutableAppliedPatchDelta): ApplyPatchError {
    if (error instanceof ApplyPatchError) {
      return new ApplyPatchError(error.message, error.details, this.snapshotDelta(delta, error.delta));
    }

    return new ApplyPatchError(
      error instanceof Error ? error.message : String(error),
      {},
      this.snapshotDelta(delta)
    );
  }

  private snapshotDelta(
    delta: MutableAppliedPatchDelta,
    fallback: AppliedPatchDelta = emptyAppliedPatchDelta()
  ): AppliedPatchDelta {
    const changes = delta.changes.length > 0 ? delta.changes : [...fallback.changes];
    return {
      changes: changes.map((change) => ({ ...change })),
      exact: delta.exact && fallback.exact
    };
  }

  private pathsFromDelta(delta: AppliedPatchDelta, extraPath?: string): readonly string[] {
    const paths = new Set<string>();
    for (const change of delta.changes) {
      paths.add(change.path);
      if (change.change.type === "update" && change.change.moveTo) {
        paths.add(change.change.moveTo);
      }
    }
    if (extraPath) {
      paths.add(extraPath);
    }
    return [...paths];
  }

  private summaryMessage(operationCount: number, delta: AppliedPatchDelta, failure: string | undefined): string {
    const exactSuffix = delta.exact ? "" : " 一部のI/O失敗によりdeltaは完全ではない可能性があります。";
    if (failure) {
      return delta.changes.length > 0
        ? `編集案の適用中に失敗しました。${delta.changes.length} 件の変更は適用済みです。失敗理由: ${failure}${exactSuffix}`
        : `編集案の適用に失敗しました。失敗理由: ${failure}${exactSuffix}`;
    }

    return `編集案を ${operationCount} 件のパッチ操作として適用しました。${exactSuffix}`.trim();
  }
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean
): number | undefined {
  if (pattern.length === 0) {
    return Math.min(start, lines.length);
  }
  if (pattern.length > lines.length) {
    return undefined;
  }

  const starts = eof && lines.length >= pattern.length
    ? [lines.length - pattern.length, start]
    : [start];
  for (const searchStart of [...new Set(starts.map((value) => Math.max(0, Math.min(value, lines.length))))]) {
    for (const matcher of [exactLine, trimEndLine, trimLine, normalizeLine]) {
      const found = seekWithMatcher(lines, pattern, searchStart, matcher);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function seekWithMatcher(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  matcher: (value: string) => string
): number | undefined {
  for (let index = start; index <= lines.length - pattern.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (matcher(lines[index + offset] ?? "") !== matcher(pattern[offset] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return index;
    }
  }
  return undefined;
}

function exactLine(value: string): string {
  return value;
}

function trimEndLine(value: string): string {
  return value.trimEnd();
}

function trimLine(value: string): string {
  return value.trim();
}

function normalizeLine(value: string): string {
  return value.trim().replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, "\"")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
