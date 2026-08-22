import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemSkillRepository } from "../src/extension/skills/fileSystemSkillRepository";

describe("FileSystemSkillRepository", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("discovers valid workspace and user skills deterministically", async () => {
    const workspaceRoot = await createRoot();
    const userRoot = await createRoot();
    await createSkill(workspaceRoot, "review-code", "Reviews code changes.");
    await createSkill(userRoot, "explain-code", "Explains unfamiliar code.");

    const result = await new FileSystemSkillRepository([
      { sourceId: "project", scope: "workspace", directoryPath: workspaceRoot },
      { sourceId: "personal", scope: "user", directoryPath: userRoot }
    ]).discover();

    expect(result.issues).toEqual([]);
    expect(result.skills.map((skill) => ({
      id: skill.id,
      name: skill.manifest.name,
      description: skill.manifest.description
    }))).toEqual([
      {
        id: "user:personal:explain-code",
        name: "explain-code",
        description: "Explains unfamiliar code."
      },
      {
        id: "workspace:project:review-code",
        name: "review-code",
        description: "Reviews code changes."
      }
    ]);
  });

  it("treats a missing root as an empty catalog", async () => {
    const parent = await createRoot();
    const result = await new FileSystemSkillRepository([{
      sourceId: "project",
      scope: "workspace",
      directoryPath: join(parent, "missing")
    }]).discover();

    expect(result).toEqual({ skills: [], issues: [] });
  });

  it("reports an invalid manifest without hiding valid skills", async () => {
    const root = await createRoot();
    await createSkill(root, "valid-skill", "A valid skill.");
    const invalidDirectory = join(root, "invalid-skill");
    await mkdir(invalidDirectory);
    await writeFile(join(invalidDirectory, "SKILL.md"), "# Missing frontmatter", "utf8");

    const result = await new FileSystemSkillRepository([{
      sourceId: "project",
      scope: "workspace",
      directoryPath: root
    }]).discover();

    expect(result.skills.map((skill) => skill.manifest.name)).toEqual(["valid-skill"]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        directoryName: "invalid-skill",
        code: "frontmatter_missing"
      })
    ]);
  });

  it("rejects directory links instead of following them", async () => {
    const root = await createRoot();
    const externalRoot = await createRoot();
    await createSkill(externalRoot, "outside-skill", "Must stay outside.");
    await symlink(join(externalRoot, "outside-skill"), join(root, "outside-skill"), "junction");

    const result = await new FileSystemSkillRepository([{
      sourceId: "project",
      scope: "workspace",
      directoryPath: root
    }]).discover();

    expect(result.skills).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        directoryName: "outside-skill",
        code: "entry_unsupported"
      })
    ]);
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mentor-code-skill-test-"));
    temporaryDirectories.push(root);
    return root;
  }

  async function createSkill(root: string, name: string, description: string): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      `# ${name}`,
      "Follow the instructions."
    ].join("\n"), "utf8");
  }
});
