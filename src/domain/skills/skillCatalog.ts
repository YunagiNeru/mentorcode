import type { SkillManifest, SkillManifestErrorCode } from "./skillManifest";

export type SkillScope = "workspace" | "user";

export interface SkillRoot {
  readonly sourceId: string;
  readonly scope: SkillScope;
  readonly directoryPath: string;
}

export interface DiscoveredSkill {
  readonly id: string;
  readonly sourceId: string;
  readonly scope: SkillScope;
  readonly directoryPath: string;
  readonly manifestPath: string;
  readonly manifest: SkillManifest;
}

export type SkillDiscoveryIssueCode = SkillManifestErrorCode
  | "root_unreadable"
  | "entry_unsupported"
  | "manifest_missing"
  | "manifest_unreadable"
  | "discovery_limit_exceeded";

export interface SkillDiscoveryIssue {
  readonly sourceId: string;
  readonly scope: SkillScope;
  readonly directoryName?: string;
  readonly code: SkillDiscoveryIssueCode;
  readonly message: string;
}

export interface SkillDiscoveryResult {
  readonly skills: readonly DiscoveredSkill[];
  readonly issues: readonly SkillDiscoveryIssue[];
}

export interface SkillRepository {
  discover(): Promise<SkillDiscoveryResult>;
}

export interface SkillCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: SkillScope;
  readonly compatibility?: string;
}
