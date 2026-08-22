import { describe, expect, it } from "vitest";
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillRepository,
  SkillScope
} from "../src/domain/skills/skillCatalog";
import { SkillSafetyAudit, isSkillActivationContext } from "../src/domain/skills/skillContext";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { SkillRegistry } from "../src/extension/skills/skillRegistry";

class StubSkillRepository implements SkillRepository {
  public constructor(private readonly result: SkillDiscoveryResult) {}

  public async discover(): Promise<SkillDiscoveryResult> {
    return this.result;
  }
}

describe("SkillRegistry", () => {
  it("activates explicitly mentioned skills and exposes only metadata in the catalog", async () => {
    const registry = createRegistry([
      skill("workspace:project:review-code", "review-code", "workspace", "Inspect edge cases.")
    ]);

    const result = await registry.activateExplicit("Please use $review-code for this change.");

    expect(result.catalog).toEqual([{
      id: "workspace:project:review-code",
      name: "review-code",
      description: "Use when reviewing code.",
      scope: "workspace"
    }]);
    expect(JSON.stringify(result.catalog)).not.toContain("Inspect edge cases");
    expect(result.activeSkills).toHaveLength(1);
    expect(result.activeSkills[0]?.instructions).toBe("Inspect edge cases.");
    expect(isSkillActivationContext(result.activeSkills[0])).toBe(true);
  });

  it("deduplicates repeated mentions and prefers a workspace skill over a user skill", async () => {
    const registry = createRegistry([
      skill("user:personal:review-code", "review-code", "user", "User instructions."),
      skill("workspace:project:review-code", "review-code", "workspace", "Workspace instructions.")
    ]);

    const result = await registry.activateExplicit("$review-code then $review-code");

    expect(result.activeSkills).toHaveLength(1);
    expect(result.activeSkills[0]?.scope).toBe("workspace");
    expect(result.activeSkills[0]?.instructions).toBe("Workspace instructions.");
  });

  it("does not interpret an MCP mention as a Skill mention", () => {
    const registry = createRegistry([]);
    expect(registry.hasExplicitInvocation("Use $mcp:search-tools for this request.")).toBe(false);
  });

  it("fails closed when the preferred scope is ambiguous", async () => {
    const registry = createRegistry([
      skill("workspace:first:review-code", "review-code", "workspace", "First."),
      skill("workspace:second:review-code", "review-code", "workspace", "Second.")
    ]);

    const result = await registry.activateExplicit("Use $review-code.");

    expect(result.activeSkills).toEqual([]);
    expect(result.activationIssues).toEqual([
      expect.objectContaining({ code: "skill_ambiguous", name: "review-code" })
    ]);
  });

  it("does not activate a skill whose instructions fail the privacy guard", async () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "ZmFrZS1wcml2YXRlLWtleS1mb3ItdGVzdGluZw==",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const registry = createRegistry([
      skill("workspace:project:unsafe-skill", "unsafe-skill", "workspace", privateKey)
    ]);

    const result = await registry.activateExplicit("Use $unsafe-skill.");

    expect(result.activeSkills).toEqual([]);
    expect(result.activationIssues).toEqual([
      expect.objectContaining({ code: "skill_unsafe", name: "unsafe-skill" })
    ]);
  });

  it("selects from safe metadata before loading an automatic skill", async () => {
    const registry = createRegistry([
      skill("workspace:project:testing", "testing", "workspace", "Testing instructions."),
      skill("user:personal:docs", "docs", "user", "Documentation instructions.")
    ]);

    const result = await registry.activateAutomatic("テストを直して", async (_task, catalog) => {
      expect(catalog.map((entry) => entry.name)).toEqual(["docs", "testing"]);
      return [catalog.find((entry) => entry.name === "testing")?.id ?? ""];
    });

    expect(result.activeSkills.map((entry) => entry.name)).toEqual(["testing"]);
    expect(result.activationIssues).toEqual([]);
  });

  it("applies workspace precedence to automatic candidates", async () => {
    const registry = createRegistry([
      skill("user:personal:testing", "testing", "user", "User instructions."),
      skill("workspace:project:testing", "testing", "workspace", "Workspace instructions.")
    ]);

    const result = await registry.activateAutomatic(
      "テスト",
      async (_task, catalog) => [catalog[0]?.id ?? ""]
    );

    expect(result.catalog).toHaveLength(1);
    expect(result.activeSkills[0]?.scope).toBe("workspace");
    expect(result.activeSkills[0]?.instructions).toBe("Workspace instructions.");
  });

  function createRegistry(skills: readonly DiscoveredSkill[]): SkillRegistry {
    return new SkillRegistry(
      new StubSkillRepository({ skills, issues: [] }),
      new SkillSafetyAudit(new PrivacyGuard())
    );
  }

  function skill(id: string, name: string, scope: SkillScope, instructions: string): DiscoveredSkill {
    return {
      id,
      sourceId: id.split(":")[1] ?? "source",
      scope,
      directoryPath: `skills/${name}`,
      manifestPath: `skills/${name}/SKILL.md`,
      manifest: {
        name,
        description: `Use when reviewing code.`,
        metadata: {},
        allowedTools: [],
        instructions
      }
    };
  }
});
