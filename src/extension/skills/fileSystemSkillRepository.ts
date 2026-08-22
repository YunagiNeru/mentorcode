import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  DiscoveredSkill,
  SkillDiscoveryIssue,
  SkillDiscoveryResult,
  SkillRoot
} from "../../domain/skills/skillCatalog";
import {
  SKILL_MANIFEST_FILE_NAME,
  SKILL_MANIFEST_MAX_BYTES,
  SkillManifestError,
  SkillManifestParser
} from "../../domain/skills/skillManifest";

export const MAX_SKILLS_PER_ROOT = 128;

export class FileSystemSkillRepository {
  public constructor(
    private readonly roots: readonly SkillRoot[],
    private readonly parser = new SkillManifestParser()
  ) {}

  public async discover(): Promise<SkillDiscoveryResult> {
    const skills: DiscoveredSkill[] = [];
    const issues: SkillDiscoveryIssue[] = [];

    for (const root of this.roots) {
      const result = await this.discoverRoot(root);
      skills.push(...result.skills);
      issues.push(...result.issues);
    }

    return {
      skills: skills.sort((left, right) => left.id.localeCompare(right.id)),
      issues
    };
  }

  private async discoverRoot(root: SkillRoot): Promise<SkillDiscoveryResult> {
    const skills: DiscoveredSkill[] = [];
    const issues: SkillDiscoveryIssue[] = [];
    const rootPath = resolve(root.directoryPath);
    let rootRealPath: string;
    let entries: Dirent<string>[];

    try {
      const rootStats = await lstat(rootPath);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        return this.issueOnly(root, "root_unreadable", "Skillルートは通常のディレクトリである必要があります。");
      }
      rootRealPath = await realpath(rootPath);
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") {
        return { skills: [], issues: [] };
      }
      return this.issueOnly(root, "root_unreadable", "Skillルートを読み取れませんでした。");
    }

    const candidates = entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (candidates.length > MAX_SKILLS_PER_ROOT) {
      issues.push(this.issue(
        root,
        "discovery_limit_exceeded",
        `Skillルートの候補数が上限 ${MAX_SKILLS_PER_ROOT} 件を超えています。`
      ));
    }

    for (const entry of candidates.slice(0, MAX_SKILLS_PER_ROOT)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        issues.push(this.issue(
          root,
          "entry_unsupported",
          "Skill候補はシンボリックリンクではないディレクトリである必要があります。",
          entry.name
        ));
        continue;
      }

      const skillResult = await this.readSkill(root, rootRealPath, rootPath, entry.name);
      if (skillResult.skill) {
        skills.push(skillResult.skill);
      }
      if (skillResult.issue) {
        issues.push(skillResult.issue);
      }
    }

    return { skills, issues };
  }

  private async readSkill(
    root: SkillRoot,
    rootRealPath: string,
    rootPath: string,
    directoryName: string
  ): Promise<{ readonly skill?: DiscoveredSkill; readonly issue?: SkillDiscoveryIssue }> {
    const directoryPath = resolve(rootPath, directoryName);
    const manifestPath = resolve(directoryPath, SKILL_MANIFEST_FILE_NAME);
    try {
      const directoryRealPath = await realpath(directoryPath);
      if (!this.isWithin(rootRealPath, directoryRealPath)) {
        return {
          issue: this.issue(
            root,
            "entry_unsupported",
            "Skill候補がSkillルートの外部を参照しています。",
            directoryName
          )
        };
      }

      const manifestStats = await lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
        return {
          issue: this.issue(
            root,
            "manifest_missing",
            `${SKILL_MANIFEST_FILE_NAME} は通常ファイルである必要があります。`,
            directoryName
          )
        };
      }
      if (manifestStats.size > SKILL_MANIFEST_MAX_BYTES) {
        throw new SkillManifestError(
          "content_too_large",
          `${SKILL_MANIFEST_FILE_NAME} が上限 ${SKILL_MANIFEST_MAX_BYTES} バイトを超えています。`
        );
      }

      const manifestRealPath = await realpath(manifestPath);
      if (!this.isWithin(directoryRealPath, manifestRealPath)) {
        return {
          issue: this.issue(
            root,
            "entry_unsupported",
            `${SKILL_MANIFEST_FILE_NAME} がSkillディレクトリの外部を参照しています。`,
            directoryName
          )
        };
      }

      const content = await readFile(manifestPath, "utf8");
      const manifest = this.parser.parse(content, { expectedDirectoryName: directoryName });
      return {
        skill: {
          id: `${root.scope}:${root.sourceId}:${manifest.name}`,
          sourceId: root.sourceId,
          scope: root.scope,
          directoryPath,
          manifestPath,
          manifest
        }
      };
    } catch (error) {
      if (error instanceof SkillManifestError) {
        return {
          issue: this.issue(root, error.code, error.message, directoryName)
        };
      }
      const code = this.errorCode(error);
      return {
        issue: this.issue(
          root,
          code === "ENOENT" ? "manifest_missing" : "manifest_unreadable",
          code === "ENOENT"
            ? `${SKILL_MANIFEST_FILE_NAME} がありません。`
            : `${SKILL_MANIFEST_FILE_NAME} を読み取れませんでした。`,
          directoryName
        )
      };
    }
  }

  private isWithin(parentPath: string, candidatePath: string): boolean {
    const relativePath = relative(parentPath, candidatePath);
    return relativePath.length > 0 &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath);
  }

  private issueOnly(
    root: SkillRoot,
    code: SkillDiscoveryIssue["code"],
    message: string
  ): SkillDiscoveryResult {
    return {
      skills: [],
      issues: [this.issue(root, code, message)]
    };
  }

  private issue(
    root: SkillRoot,
    code: SkillDiscoveryIssue["code"],
    message: string,
    directoryName?: string
  ): SkillDiscoveryIssue {
    return {
      sourceId: root.sourceId,
      scope: root.scope,
      ...(directoryName ? { directoryName } : {}),
      code,
      message
    };
  }

  private errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  }
}
