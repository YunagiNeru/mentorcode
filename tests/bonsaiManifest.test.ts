import { describe, expect, it } from "vitest";
import { BonsaiManifestReader, type BonsaiManifest } from "../src/localLlm/bonsaiManifest";

describe("BonsaiManifestReader", () => {
  it("verifies the bundled Bonsai model and llama.cpp launcher hashes", async () => {
    const paths = await new BonsaiManifestReader("vendor/bonsai").verify();

    expect(paths.modelPath.endsWith("Bonsai-1.7B-Q1_0.gguf")).toBe(true);
    expect(paths.binaryPath.endsWith("llama-cli.exe")).toBe(true);
  });

  it("rejects manifest paths that only share the same string prefix", () => {
    const manifest: BonsaiManifest = {
      name: "1-Bit Bonsai 1.7B",
      model: {
        file: "../bonsai-extra/model.gguf",
        sha256: "unused",
        source: "unused",
        license: "Apache-2.0"
      },
      runtime: {
        name: "llama.cpp",
        release: "unused",
        platform: "win-x64-cpu",
        binary: "bin/win-x64/llama-cli.exe",
        binarySha256: "unused",
        source: "unused"
      }
    };

    expect(() => new BonsaiManifestReader("C:/safe/bonsai").resolvePaths(manifest)).toThrow(
      "Bonsai manifest paths must stay inside the Bonsai vendor directory."
    );
  });
});
