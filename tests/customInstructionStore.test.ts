import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_INSTRUCTION_MAX_BYTES,
  CustomInstructionStore,
  CustomInstructionStoreError
} from "../src/extension/customInstructionStore";

describe("CustomInstructionStore", () => {
  let temporaryHome: string;

  beforeEach(async () => {
    temporaryHome = await mkdtemp(join(tmpdir(), "custom-instruction-store-"));
  });

  afterEach(async () => {
    await rm(temporaryHome, { recursive: true, force: true });
  });

  it("creates one empty AGENTS.md under the user home directory", async () => {
    const store = new CustomInstructionStore(temporaryHome);

    const document = await store.initialize();

    expect(document.content).toBe("");
    expect(document.filePath).toBe(join(temporaryHome, ".mentor-code", "AGENTS.md"));
    await expect(readFile(document.filePath, "utf8")).resolves.toBe("");
  });

  it("never overwrites an existing AGENTS.md during initialization", async () => {
    const store = new CustomInstructionStore(temporaryHome);
    await store.initialize();
    await writeFile(store.filePath, "既存の指示", "utf8");

    const document = await store.initialize();

    expect(document.content).toBe("既存の指示");
  });

  it("saves content when the expected revision is current", async () => {
    const store = new CustomInstructionStore(temporaryHome);
    const initial = await store.initialize();

    const saved = await store.save("# 作業ルール\n", initial.revision);

    expect(saved.content).toBe("# 作業ルール\n");
    expect(saved.revision).not.toBe(initial.revision);
    await expect(readFile(store.filePath, "utf8")).resolves.toBe("# 作業ルール\n");
  });

  it("rejects a stale save after an external edit", async () => {
    const store = new CustomInstructionStore(temporaryHome);
    const initial = await store.initialize();
    await writeFile(store.filePath, "外部変更", "utf8");

    await expect(store.save("古い画面の内容", initial.revision)).rejects.toMatchObject({
      code: "conflict"
    });
    await expect(readFile(store.filePath, "utf8")).resolves.toBe("外部変更");
  });

  it("rejects content larger than the byte limit without changing the file", async () => {
    const store = new CustomInstructionStore(temporaryHome);
    const initial = await store.initialize();

    const oversized = "a".repeat(CUSTOM_INSTRUCTION_MAX_BYTES + 1);
    const saving = store.save(oversized, initial.revision);

    await expect(saving).rejects.toBeInstanceOf(CustomInstructionStoreError);
    await expect(saving).rejects.toMatchObject({ code: "too_large" });
    await expect(readFile(store.filePath, "utf8")).resolves.toBe("");
  });
});
