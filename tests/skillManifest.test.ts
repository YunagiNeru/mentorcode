import { describe, expect, it } from "vitest";
import {
  SKILL_MANIFEST_MAX_BYTES,
  SkillManifestError,
  SkillManifestParser
} from "../src/domain/skills/skillManifest";

describe("SkillManifestParser", () => {
  const parser = new SkillManifestParser();

  it("parses an Agent Skills compatible manifest", () => {
    const manifest = parser.parse([
      "---",
      "name: code-review",
      "description: Reviews code when a user asks for review feedback.",
      "license: MIT",
      "compatibility: Requires git",
      "metadata:",
      "  author: example-org",
      "  version: \"1.0\"",
      "allowed-tools: Read Bash(git:*)",
      "---",
      "# Review",
      "Follow the review checklist."
    ].join("\n"), { expectedDirectoryName: "code-review" });

    expect(manifest).toEqual({
      name: "code-review",
      description: "Reviews code when a user asks for review feedback.",
      license: "MIT",
      compatibility: "Requires git",
      metadata: {
        author: "example-org",
        version: "1.0"
      },
      allowedTools: ["Read", "Bash(git:*)"],
      instructions: "# Review\nFollow the review checklist."
    });
  });

  it("rejects a manifest without YAML frontmatter", () => {
    expect(() => parser.parse("# Skill\nInstructions"))
      .toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: "frontmatter_missing" }));
  });

  it("rejects duplicate YAML keys", () => {
    expect(() => parser.parse([
      "---",
      "name: code-review",
      "name: changed-name",
      "description: Reviews code.",
      "---"
    ].join("\n"))).toThrowError(expect.objectContaining<Partial<SkillManifestError>>({
      code: "frontmatter_invalid"
    }));
  });

  it("rejects names that do not match the parent directory", () => {
    expect(() => parser.parse([
      "---",
      "name: code-review",
      "description: Reviews code.",
      "---"
    ].join("\n"), { expectedDirectoryName: "different-name" }))
      .toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: "name_mismatch" }));
  });

  it("rejects unsupported fields and non-string metadata", () => {
    expect(() => parser.parse([
      "---",
      "name: code-review",
      "description: Reviews code.",
      "unexpected: true",
      "---"
    ].join("\n"))).toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: "field_invalid" }));

    expect(() => parser.parse([
      "---",
      "name: code-review",
      "description: Reviews code.",
      "metadata:",
      "  version: 1",
      "---"
    ].join("\n"))).toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: "field_invalid" }));
  });

  it("rejects oversized content before parsing", () => {
    const content = [
      "---",
      "name: large-skill",
      "description: Large skill.",
      "---",
      "a".repeat(SKILL_MANIFEST_MAX_BYTES)
    ].join("\n");

    expect(() => parser.parse(content))
      .toThrowError(expect.objectContaining<Partial<SkillManifestError>>({ code: "content_too_large" }));
  });
});
