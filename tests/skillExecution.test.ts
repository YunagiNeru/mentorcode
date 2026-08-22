import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_SKILLS,
  SkillExecutionGuard,
  isSkillExecutionContext
} from "../src/domain/skills/skillExecution";
import {
  SKILL_CONTEXT_SCHEMA_VERSION,
  type SkillActivationContext
} from "../src/domain/skills/skillContext";
import { instructionRevision } from "../src/domain/instructionSafety";

describe("SkillExecutionGuard", () => {
  it("accepts a self-verifying unique skill context", () => {
    const context = { activeSkills: [skill("review-code", "Review edge cases.")] };

    expect(isSkillExecutionContext(context)).toBe(true);
    expect(new SkillExecutionGuard().inspect(context).accepted).toBe(true);
  });

  it("rejects modified instructions and duplicate ids", () => {
    const original = skill("review-code", "Review edge cases.");

    expect(isSkillExecutionContext({
      activeSkills: [{ ...original, instructions: "Modified" }]
    })).toBe(false);
    expect(isSkillExecutionContext({
      activeSkills: [original, original]
    })).toBe(false);
  });

  it("limits the number of active skills", () => {
    expect(isSkillExecutionContext({
      activeSkills: Array.from({ length: MAX_ACTIVE_SKILLS + 1 }, (_, index) => (
        skill(`skill-${index}`, `Instruction ${index}.`)
      ))
    })).toBe(false);
  });

  it("rejects a correctly hashed context when masked secrets remain", () => {
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";
    const context = { activeSkills: [skill("unsafe-skill", `API_KEY=${fakeKey}`)] };

    const result = new SkillExecutionGuard().inspect(context);

    expect(isSkillExecutionContext(context)).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("秘密情報候補");
  });

  function skill(name: string, instructions: string): SkillActivationContext {
    const description = "Use for code review.";
    const combined = [description, instructions].join("\n");
    return {
      schemaVersion: SKILL_CONTEXT_SCHEMA_VERSION,
      id: `workspace:project:${name}`,
      name,
      description,
      scope: "workspace",
      instructions,
      revision: instructionRevision(combined),
      byteLength: Buffer.byteLength(combined, "utf8")
    };
  }
});
