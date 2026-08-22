import { PrivacyGuard } from "../privacy/privacyGuard";
import type { FileGuardResult } from "../types";
import { isSkillActivationContext, type SkillActivationContext } from "./skillContext";
import { SKILL_MANIFEST_MAX_BYTES } from "./skillManifest";

export const MAX_ACTIVE_SKILLS = 4;

export interface SkillExecutionContext {
  readonly activeSkills: readonly SkillActivationContext[];
}

export interface SkillExecutionGuardDecision {
  readonly accepted: boolean;
  readonly reason: string;
  readonly results: readonly FileGuardResult[];
}

export function isSkillExecutionContext(value: unknown): value is SkillExecutionContext {
  if (!isRecord(value) || !Array.isArray(value.activeSkills) || value.activeSkills.length > MAX_ACTIVE_SKILLS) {
    return false;
  }
  if (!value.activeSkills.every(isSkillActivationContext)) {
    return false;
  }
  return new Set(value.activeSkills.map((skill) => skill.id)).size === value.activeSkills.length;
}

export class SkillExecutionGuard {
  private readonly guard = new PrivacyGuard({ maxFileBytes: SKILL_MANIFEST_MAX_BYTES });

  public inspect(context: SkillExecutionContext): SkillExecutionGuardDecision {
    if (!isSkillExecutionContext(context)) {
      return {
        accepted: false,
        reason: "Skill実行コンテキストの形式が不正です。",
        results: []
      };
    }

    const results: FileGuardResult[] = [];
    for (const skill of context.activeSkills) {
      results.push(this.guard.analyzeFile({
        path: `agent-skills/${skill.name}/description.txt`,
        content: skill.description
      }));
      results.push(this.guard.analyzeFile({
        path: `agent-skills/${skill.name}/SKILL.md`,
        content: skill.instructions
      }));
    }

    const unsafe = results.find((result) => result.blocked ||
      result.excluded ||
      result.maskedContent === undefined ||
      result.findings.some((finding) => finding.action === "mask" || finding.action === "block"));
    if (unsafe) {
      return {
        accepted: false,
        reason: "Skill実行コンテキストの再検査で未処理の秘密情報候補を検出しました。",
        results
      };
    }

    return {
      accepted: true,
      reason: "Skill実行コンテキストのサーバー側再検査が完了しました。",
      results
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
