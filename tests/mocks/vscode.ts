import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

export class Uri {
  private constructor(public readonly fsPath: string) {}

  public static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
}

const configurationValues = new Map<string, unknown>();

export const workspace = {
  workspaceFolders: [] as { readonly uri: Uri; readonly name: string; readonly index: number }[],
  fs: {
    async stat(uri: Uri): Promise<{ readonly type: FileType; readonly ctime: number; readonly mtime: number; readonly size: number }> {
      const result = await stat(uri.fsPath);
      return {
        type: result.isDirectory() ? FileType.Directory : FileType.File,
        ctime: result.ctimeMs,
        mtime: result.mtimeMs,
        size: result.size
      };
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      return new Uint8Array(await readFile(uri.fsPath));
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await mkdir(dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, Buffer.from(content));
    },
    async createDirectory(uri: Uri): Promise<void> {
      await mkdir(uri.fsPath, { recursive: true });
    },
    async delete(uri: Uri, options: { readonly recursive?: boolean } = {}): Promise<void> {
      await rm(uri.fsPath, {
        recursive: options.recursive === true,
        force: false
      });
    },
    async rename(source: Uri, target: Uri, options: { readonly overwrite?: boolean } = {}): Promise<void> {
      if (options.overwrite !== true) {
        try {
          await stat(target.fsPath);
          throw new Error(`Target already exists: ${target.fsPath}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }

      await mkdir(dirname(target.fsPath), { recursive: true });
      await rename(source.fsPath, target.fsPath);
    }
  },
  async openTextDocument(uri: Uri): Promise<{ readonly isDirty: boolean; getText(): string }> {
    const content = await readFile(uri.fsPath, "utf8");
    return {
      isDirty: false,
      getText: () => content
    };
  },
  getConfiguration(section?: string): {
    get<T>(key: string, defaultValue?: T): T;
    update(key: string, value: unknown): Promise<void>;
  } {
    return {
      get<T>(key: string, defaultValue?: T): T {
        const scopedKey = section ? `${section}.${key}` : key;
        if (configurationValues.has(scopedKey)) {
          return configurationValues.get(scopedKey) as T;
        }

        return defaultValue as T;
      },
      async update(key: string, value: unknown): Promise<void> {
        const scopedKey = section ? `${section}.${key}` : key;
        if (value === undefined) {
          configurationValues.delete(scopedKey);
          return;
        }

        configurationValues.set(scopedKey, value);
      }
    };
  }
};
