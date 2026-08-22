import { InstructionSafetyAudit, instructionRevision } from "../instructionSafety";
import { PrivacyGuard } from "../privacy/privacyGuard";
import type { FileGuardResult } from "../types";
import type { DiscoveredSkill, SkillCatalogEntry, SkillScope } from "./skillCatalog";
import { SKILL_MANIFEST_MAX_BYTES } from "./skillManifest";

export const SKILL_CONTEXT_SCHEMA_VERSION = "mentorcode.skill_context.v1";

export interface SkillActivationContext {
  readonly schemaVersion: typeof SKILL_CONTEXT_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly instructions: string;
  readonly revision: string;
  readonly byteLength: number;
}

interface AcceptedSkillSafetyDecision {
  readonly accepted: true;
  readonly reason: string;
  readonly context: SkillActivationContext;
  readonly results: readonly FileGuardResult[];
}

interface RejectedSkillSafetyDecision {
  readonly accepted: false;
  readonly reason: string;
  readonly results: readonly FileGuardResult[];
}

export type SkillSafetyDecision = AcceptedSkillSafetyDecision | RejectedSkillSafetyDecision;

export type SkillCatalogSafetyDecision =
  | {
    readonly accepted: true;
    readonly reason: string;
    readonly entry: SkillCatalogEntry;
    readonly result: FileGuardResult;
  }
  | {
    readonly accepted: false;
    readonly reason: string;
    readonly result: FileGuardResult;
  };

export class SkillSafetyAudit {
  public constructor(private readonly guard: PrivacyGuard) {}

  public async sanitizeCatalogEntry(skill: DiscoveredSkill): Promise<SkillCatalogSafetyDecision> {
    const decision = await this.descriptionAudit(skill).sanitize(skill.manifest.description);
    if (!decision.accepted) {
      return {
        accepted: false,
        reason: decision.reason,
        result: decision.result
      };
    }
    return {
      accepted: true,
      reason: decision.reason,
      entry: {
        id: skill.id,
        name: skill.manifest.name,
        description: decision.maskedContent,
        scope: skill.scope
      },
      result: decision.result
    };
  }

  public async sanitize(skill: DiscoveredSkill): Promise<SkillSafetyDecision> {
    const descriptionDecision = await this.descriptionAudit(skill).sanitize(skill.manifest.description);
    if (!descriptionDecision.accepted) {
      return {
        accepted: false,
        reason: descriptionDecision.reason,
        results: [descriptionDecision.result]
      };
    }

    const instructionsDecision = await new InstructionSafetyAudit(this.guard, {
      path: `agent-skills/${skill.manifest.name}/SKILL.md`,
      displayName: `${skill.manifest.name} Skill`,
      maxBytes: SKILL_MANIFEST_MAX_BYTES
    }).sanitize(skill.manifest.instructions);
    if (!instructionsDecision.accepted) {
      return {
        accepted: false,
        reason: instructionsDecision.reason,
        results: [descriptionDecision.result, instructionsDecision.result]
      };
    }

    const revision = instructionRevision([
      descriptionDecision.maskedContent,
      instructionsDecision.maskedContent
    ].join("\n"));
    const byteLength = Buffer.byteLength([
      descriptionDecision.maskedContent,
      instructionsDecision.maskedContent
    ].join("\n"), "utf8");
    return {
      accepted: true,
      reason: [descriptionDecision.reason, instructionsDecision.reason].join(" "),
      context: {
        schemaVersion: SKILL_CONTEXT_SCHEMA_VERSION,
        id: skill.id,
        name: skill.manifest.name,
        description: descriptionDecision.maskedContent,
        scope: skill.scope,
        instructions: instructionsDecision.maskedContent,
        revision,
        byteLength
      },
      results: [descriptionDecision.result, instructionsDecision.result]
    };
  }

  private descriptionAudit(skill: DiscoveredSkill): InstructionSafetyAudit {
    return new InstructionSafetyAudit(this.guard, {
      path: `agent-skills/${skill.manifest.name}/description.txt`,
      displayName: `${skill.manifest.name} Skillのdescription`,
      maxBytes: 4 * 1024
    });
  }
}

export function isSkillActivationContext(value: unknown): value is SkillActivationContext {
  if (!isRecord(value)) {
    return false;
  }
  if (value.schemaVersion !== SKILL_CONTEXT_SCHEMA_VERSION ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    (value.scope !== "workspace" && value.scope !== "user") ||
    typeof value.instructions !== "string" ||
    typeof value.revision !== "string" ||
    typeof value.byteLength !== "number") {
    return false;
  }

  return value.revision === instructionRevision([
    value.description,
    value.instructions
  ].join("\n")) && value.byteLength === Buffer.byteLength([
    value.description,
    value.instructions
  ].join("\n"), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
