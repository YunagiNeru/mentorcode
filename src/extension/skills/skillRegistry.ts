import type {
  DiscoveredSkill,
  SkillCatalogEntry,
  SkillDiscoveryIssue,
  SkillRepository
} from "../../domain/skills/skillCatalog";
import type { SkillActivationContext } from "../../domain/skills/skillContext";
import { SkillSafetyAudit } from "../../domain/skills/skillContext";

export type SkillActivationIssueCode = "skill_missing" | "skill_ambiguous" | "skill_unsafe";

export interface SkillActivationIssue {
  readonly name: string;
  readonly code: SkillActivationIssueCode;
  readonly message: string;
}

export interface SkillActivationResult {
  readonly catalog: readonly SkillCatalogEntry[];
  readonly activeSkills: readonly SkillActivationContext[];
  readonly discoveryIssues: readonly SkillDiscoveryIssue[];
  readonly activationIssues: readonly SkillActivationIssue[];
  readonly catalogIssues?: readonly SkillActivationIssue[];
}

export type SkillSelector = (
  task: string,
  catalog: readonly SkillCatalogEntry[]
) => Promise<readonly string[]>;

export class SkillRegistry {
  public constructor(
    private readonly repository: SkillRepository,
    private readonly safetyAudit: SkillSafetyAudit
  ) {}

  public async activateExplicit(task: string): Promise<SkillActivationResult> {
    const discovery = await this.repository.discover();
    const catalog = discovery.skills.map((skill) => this.catalogEntry(skill));
    const activeSkills: SkillActivationContext[] = [];
    const activationIssues: SkillActivationIssue[] = [];

    for (const name of this.explicitSkillNames(task)) {
      const resolution = this.resolveByName(name, discovery.skills);
      if (resolution.issue) {
        activationIssues.push(resolution.issue);
        continue;
      }
      if (!resolution.skill) {
        activationIssues.push({
          name,
          code: "skill_missing",
          message: `$${name} に一致するSkillが見つかりません。`
        });
        continue;
      }

      const safety = await this.safetyAudit.sanitize(resolution.skill);
      if (!safety.accepted) {
        activationIssues.push({
          name,
          code: "skill_unsafe",
          message: safety.reason
        });
        continue;
      }
      activeSkills.push(safety.context);
    }

    return {
      catalog,
      activeSkills,
      discoveryIssues: discovery.issues,
      activationIssues
    };
  }

  public async activateAutomatic(task: string, selector: SkillSelector): Promise<SkillActivationResult> {
    const discovery = await this.repository.discover();
    const catalog: SkillCatalogEntry[] = [];
    const catalogIssues: SkillActivationIssue[] = [];
    const effectiveSkills = this.effectiveSkills(discovery.skills, catalogIssues);

    for (const skill of effectiveSkills) {
      const safety = await this.safetyAudit.sanitizeCatalogEntry(skill);
      if (!safety.accepted) {
        catalogIssues.push({
          name: skill.manifest.name,
          code: "skill_unsafe",
          message: safety.reason
        });
        continue;
      }
      catalog.push(safety.entry);
    }

    const selectedIds = catalog.length === 0 ? [] : await selector(task, catalog);
    const allowedIds = new Set(catalog.map((entry) => entry.id));
    const activeSkills: SkillActivationContext[] = [];
    const activationIssues: SkillActivationIssue[] = [];
    for (const id of [...new Set(selectedIds)].slice(0, 4)) {
      if (!allowedIds.has(id)) {
        continue;
      }
      const skill = effectiveSkills.find((candidate) => candidate.id === id);
      if (!skill) {
        continue;
      }
      const safety = await this.safetyAudit.sanitize(skill);
      if (!safety.accepted) {
        activationIssues.push({
          name: skill.manifest.name,
          code: "skill_unsafe",
          message: safety.reason
        });
        continue;
      }
      activeSkills.push(safety.context);
    }

    return {
      catalog,
      activeSkills,
      discoveryIssues: discovery.issues,
      activationIssues,
      catalogIssues
    };
  }

  public hasExplicitInvocation(task: string): boolean {
    return this.explicitSkillNames(task).length > 0;
  }

  private explicitSkillNames(task: string): readonly string[] {
    const names = new Set<string>();
    for (const match of task.matchAll(/(?:^|\s)\$([a-z0-9]+(?:-[a-z0-9]+)*)\b(?!:)/g)) {
      const name = match[1];
      if (name) {
        names.add(name);
      }
    }
    return [...names];
  }

  private resolveByName(
    name: string,
    skills: readonly DiscoveredSkill[]
  ): { readonly skill?: DiscoveredSkill; readonly issue?: SkillActivationIssue } {
    const matches = skills.filter((skill) => skill.manifest.name === name);
    if (matches.length === 0) {
      return {};
    }

    const workspaceMatches = matches.filter((skill) => skill.scope === "workspace");
    const preferred = workspaceMatches.length > 0 ? workspaceMatches : matches;
    if (preferred.length > 1) {
      return {
        issue: {
          name,
          code: "skill_ambiguous",
          message: `$${name} に同一優先度のSkillが複数あるため、有効化できません。`
        }
      };
    }
    const selected = preferred[0];
    return selected ? { skill: selected } : {};
  }

  private effectiveSkills(
    skills: readonly DiscoveredSkill[],
    issues: SkillActivationIssue[]
  ): readonly DiscoveredSkill[] {
    const names = [...new Set(skills.map((skill) => skill.manifest.name))].sort();
    const effective: DiscoveredSkill[] = [];
    for (const name of names) {
      const resolution = this.resolveByName(name, skills);
      if (resolution.issue) {
        issues.push(resolution.issue);
      } else if (resolution.skill) {
        effective.push(resolution.skill);
      }
    }
    return effective;
  }

  private catalogEntry(skill: DiscoveredSkill): SkillCatalogEntry {
    return {
      id: skill.id,
      name: skill.manifest.name,
      description: skill.manifest.description,
      scope: skill.scope,
      ...(skill.manifest.compatibility ? { compatibility: skill.manifest.compatibility } : {})
    };
  }
}
