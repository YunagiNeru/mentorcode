import { describe, expect, it } from "vitest";
import {
  CustomInstructionEditorModel,
  type CustomInstructionSnapshot
} from "../src/webview/customInstructionEditorModel";

function snapshot(content: string, revision: string): CustomInstructionSnapshot {
  return {
    content,
    revision,
    byteLength: new TextEncoder().encode(content).byteLength,
    filePath: "C:/home/.mentor-code/AGENTS.md",
    directoryPath: "C:/home/.mentor-code"
  };
}

describe("CustomInstructionEditorModel", () => {
  it("queues a newer draft while one save is in flight", () => {
    const model = new CustomInstructionEditorModel();
    model.load(snapshot("old", "r1"));
    model.edit("first");

    expect(model.beginSave()).toEqual({ content: "first", expectedRevision: "r1" });
    model.edit("second");
    expect(model.beginSave()).toBeUndefined();

    model.applySaved(snapshot("first", "r2"));
    expect(model.status).toBe("pending");
    expect(model.beginSave()).toEqual({ content: "second", expectedRevision: "r2" });
  });

  it("does not silently overwrite an external edit", () => {
    const model = new CustomInstructionEditorModel();
    model.load(snapshot("old", "r1"));
    model.edit("local");
    model.beginSave();

    model.failSave("競合", snapshot("external", "r2"));

    expect(model.status).toBe("conflict");
    expect(model.draft).toBe("local");
    model.reloadConflict();
    expect(model.draft).toBe("external");
    expect(model.revision).toBe("r2");
  });

  it("requires an explicit action before overwriting a conflict", () => {
    const model = new CustomInstructionEditorModel();
    model.load(snapshot("old", "r1"));
    model.edit("local");
    model.beginSave();
    model.failSave("競合", snapshot("external", "r2"));

    model.prepareConflictOverwrite();

    expect(model.beginSave()).toEqual({ content: "local", expectedRevision: "r2" });
  });

  it("blocks a draft over the configured byte limit", () => {
    const model = new CustomInstructionEditorModel(4);
    model.load(snapshot("", "r1"));

    model.edit("12345");

    expect(model.status).toBe("too_large");
    expect(model.beginSave()).toBeUndefined();
  });
});
