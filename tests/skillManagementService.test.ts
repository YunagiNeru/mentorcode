import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { SkillManagementService } from "../src/extension/skills/skillManagementService";

describe("SkillManagementService", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("audits README and installs only the prepared revision", async () => {
    const root = await temporaryRoot();
    const source = join(root, "example-skill");
    const target = join(root, "installed");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: Example workflow.\n---\n# Steps\nReview first.\n", "utf8");
    await writeFile(join(source, "README.md"), "# Example\nSafe preview.", "utf8");
    const service = new SkillManagementService(join(root, "staging"), new PrivacyGuard());

    const candidate = await service.prepareLocal(source);
    const installed = await service.install(candidate.id, target);

    expect(candidate.readme).toContain("Safe preview");
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toContain("Review first");
  });

  it("rejects symbolic links inside a candidate", async () => {
    const root = await temporaryRoot();
    const source = join(root, "linked-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: linked-skill\ndescription: Linked workflow.\n---\nReview.\n", "utf8");
    const external = join(root, "external");
    await mkdir(external);
    await writeFile(join(external, "content.md"), "outside", "utf8");
    await symlink(external, join(source, "linked"), "junction");
    const service = new SkillManagementService(join(root, "staging"), new PrivacyGuard());

    await expect(service.prepareLocal(source)).rejects.toThrow("シンボリックリンク");
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mentor-code-skill-management-"));
    temporaryDirectories.push(root);
    return root;
  }
});
