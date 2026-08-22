import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CUSTOM_INSTRUCTION_DIRECTORY_NAME,
  CUSTOM_INSTRUCTION_FILE_NAME,
  CUSTOM_INSTRUCTION_MAX_BYTES,
  customInstructionRevision
} from "../domain/customInstructions";

export {
  CUSTOM_INSTRUCTION_DIRECTORY_NAME,
  CUSTOM_INSTRUCTION_FILE_NAME,
  CUSTOM_INSTRUCTION_MAX_BYTES
} from "../domain/customInstructions";

export interface CustomInstructionDocument {
  readonly content: string;
  readonly revision: string;
  readonly byteLength: number;
  readonly filePath: string;
  readonly directoryPath: string;
}

export type CustomInstructionStoreErrorCode = "conflict" | "too_large";

export class CustomInstructionStoreError extends Error {
  public constructor(
    public readonly code: CustomInstructionStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CustomInstructionStoreError";
  }
}

export class CustomInstructionStore {
  public readonly directoryPath: string;
  public readonly filePath: string;
  private pendingSave: Promise<unknown> = Promise.resolve();

  public constructor(homeDirectory = homedir()) {
    this.directoryPath = join(homeDirectory, CUSTOM_INSTRUCTION_DIRECTORY_NAME);
    this.filePath = join(this.directoryPath, CUSTOM_INSTRUCTION_FILE_NAME);
  }

  public async initialize(): Promise<CustomInstructionDocument> {
    await mkdir(this.directoryPath, { recursive: true });
    try {
      await writeFile(this.filePath, "", {
        encoding: "utf8",
        flag: "wx"
      });
    } catch (error) {
      if (!this.isFileExistsError(error)) {
        throw error;
      }
    }

    return this.read();
  }

  public async read(): Promise<CustomInstructionDocument> {
    await this.initializeIfMissing();
    const content = await readFile(this.filePath, "utf8");
    return this.toDocument(content);
  }

  public save(content: string, expectedRevision: string): Promise<CustomInstructionDocument> {
    const operation = this.pendingSave.then(() => this.saveSerially(content, expectedRevision));
    this.pendingSave = operation.catch(() => undefined);
    return operation;
  }

  private async saveSerially(content: string, expectedRevision: string): Promise<CustomInstructionDocument> {
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > CUSTOM_INSTRUCTION_MAX_BYTES) {
      throw new CustomInstructionStoreError(
        "too_large",
        `AGENTS.md は ${CUSTOM_INSTRUCTION_MAX_BYTES} バイト以下にしてください。`
      );
    }

    const current = await this.read();
    if (current.revision !== expectedRevision) {
      throw new CustomInstructionStoreError(
        "conflict",
        "AGENTS.md が外部で変更されたため、自動保存を停止しました。"
      );
    }

    if (current.content === content) {
      return current;
    }

    const temporaryPath = join(this.directoryPath, `.${CUSTOM_INSTRUCTION_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, content, {
        encoding: "utf8",
        flag: "wx"
      });
      await this.renameWithRetry(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return this.toDocument(content);
  }

  private async initializeIfMissing(): Promise<void> {
    try {
      await access(this.filePath, constants.F_OK);
    } catch {
      await this.initialize();
    }
  }

  private async renameWithRetry(source: string, target: string): Promise<void> {
    const retryDelays = [0, 15, 40, 80];
    let lastError: unknown;
    for (const delay of retryDelays) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      try {
        await rename(source, target);
        return;
      } catch (error) {
        lastError = error;
        if (!this.isRetryableRenameError(error)) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private toDocument(content: string): CustomInstructionDocument {
    return {
      content,
      revision: customInstructionRevision(content),
      byteLength: Buffer.byteLength(content, "utf8"),
      filePath: this.filePath,
      directoryPath: this.directoryPath
    };
  }

  private isFileExistsError(error: unknown): boolean {
    return this.errorCode(error) === "EEXIST";
  }

  private isRetryableRenameError(error: unknown): boolean {
    return ["EACCES", "EBUSY", "EPERM"].includes(this.errorCode(error) ?? "");
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  }
}
