import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface BonsaiManifest {
  readonly name: string;
  readonly model: {
    readonly file: string;
    readonly sha256: string;
    readonly source: string;
    readonly license: string;
  };
  readonly runtime: {
    readonly name: string;
    readonly release: string;
    readonly platform: string;
    readonly binary: string;
    readonly binarySha256: string;
    readonly source: string;
  };
}

export interface BonsaiResolvedPaths {
  readonly root: string;
  readonly modelPath: string;
  readonly binaryPath: string;
  readonly runtimeDirectory: string;
}

export class BonsaiManifestReader {
  public constructor(private readonly root: string) {}

  public async read(): Promise<BonsaiManifest> {
    const manifestPath = join(this.root, "manifest.json");
    return JSON.parse(await readFile(manifestPath, "utf-8")) as BonsaiManifest;
  }

  public resolvePaths(manifest: BonsaiManifest): BonsaiResolvedPaths {
    const root = resolve(this.root);
    const modelPath = resolve(root, manifest.model.file);
    const binaryPath = resolve(root, manifest.runtime.binary);
    const runtimeDirectory = resolve(binaryPath, "..");

    if (!this.isInsideRoot(root, modelPath) || !this.isInsideRoot(root, binaryPath)) {
      throw new Error("Bonsai manifest paths must stay inside the Bonsai vendor directory.");
    }

    return {
      root,
      modelPath,
      binaryPath,
      runtimeDirectory
    };
  }

  private isInsideRoot(root: string, target: string): boolean {
    const relativePath = relative(root, target);
    return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  }

  public async verify(): Promise<BonsaiResolvedPaths> {
    const manifest = await this.read();
    const paths = this.resolvePaths(manifest);

    await this.assertHash(paths.modelPath, manifest.model.sha256, "Bonsai model");
    await this.assertHash(paths.binaryPath, manifest.runtime.binarySha256, "llama.cpp binary");

    return paths;
  }

  private async assertHash(path: string, expectedHash: string, label: string): Promise<void> {
    const bytes = await readFile(path);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expectedHash.toLowerCase()) {
      throw new Error(`${label} SHA-256 mismatch.`);
    }
  }
}
