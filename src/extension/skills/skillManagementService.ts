import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { PrivacyGuard } from "../../domain/privacy/privacyGuard";
import type { SkillManifest } from "../../domain/skills/skillManifest";
import { SkillManifestParser } from "../../domain/skills/skillManifest";

const execFileAsync = promisify(execFile);
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

export interface PreparedSkillInstall {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly directoryPath: string;
  readonly manifest: SkillManifest;
  readonly readme?: string;
  readonly auditedContent: string;
  readonly revision: string;
  readonly warnings: readonly string[];
}

export class SkillManagementService {
  private readonly parser = new SkillManifestParser();
  private readonly prepared = new Map<string, PreparedSkillInstall>();

  public constructor(
    private readonly stagingRoot: string,
    private readonly guard: PrivacyGuard
  ) {}

  public async prepareLocal(directoryPath: string): Promise<PreparedSkillInstall> {
    const root = resolve(directoryPath);
    return this.prepare(root, `local:${root}`);
  }

  public async prepareGit(rawSource: string): Promise<PreparedSkillInstall> {
    const source = this.gitSource(rawSource);
    await mkdir(this.stagingRoot, { recursive: true });
    const checkout = join(this.stagingRoot, `git-${randomUUID()}`);
    const args = ["-c", "http.followRedirects=false", "clone", "--depth", "1"];
    if (source.ref) {
      args.push("--branch", source.ref);
    }
    args.push(source.url, checkout);
    await execFileAsync("git", args, { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const selected = source.path ? resolve(checkout, source.path) : checkout;
    if (!this.within(checkout, selected) && selected !== checkout) {
      await rm(checkout, { recursive: true, force: true });
      throw new Error("Skillのサブディレクトリが取得先の外部を参照しています。");
    }
    try {
      return await this.prepare(selected, rawSource);
    } catch (error) {
      await rm(checkout, { recursive: true, force: true });
      throw error;
    }
  }

  public async install(id: string, targetRoot: string): Promise<string> {
    const candidate = this.prepared.get(id);
    if (!candidate) {
      throw new Error("承認対象のSkill候補がありません。");
    }
    await mkdir(targetRoot, { recursive: true });
    const target = join(targetRoot, candidate.name);
    const incoming = join(targetRoot, `.${candidate.name}.installing-${randomUUID()}`);
    const rollbackRoot = join(targetRoot, ".mentorcode-rollback");
    const backup = join(rollbackRoot, candidate.name);
    let backedUp = false;
    try {
      await cp(candidate.directoryPath, incoming, { recursive: true, errorOnExist: true, force: false });
      if (await this.exists(target)) {
        await mkdir(rollbackRoot, { recursive: true });
        await rm(backup, { recursive: true, force: true });
        await rename(target, backup);
        backedUp = true;
      }
      await rename(incoming, target);
      const installed = await this.prepare(target, candidate.source, false);
      if (installed.revision !== candidate.revision) {
        throw new Error("インストール後のSkill内容が承認時から変化しました。");
      }
      await this.reject(id);
      return target;
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      if (backedUp) {
        await rm(target, { recursive: true, force: true });
        await rename(backup, target);
      }
      throw error;
    }
  }

  public async reject(id: string): Promise<void> {
    const candidate = this.prepared.get(id);
    this.prepared.delete(id);
    if (candidate && this.within(this.stagingRoot, candidate.directoryPath)) {
      const relativePath = relative(this.stagingRoot, candidate.directoryPath).split(sep)[0];
      if (relativePath) {
        await rm(join(this.stagingRoot, relativePath), { recursive: true, force: true });
      }
    }
  }

  private async prepare(directoryPath: string, source: string, remember = true): Promise<PreparedSkillInstall> {
    const skillDirectory = await this.findSkillDirectory(directoryPath);
    const files = await this.files(skillDirectory);
    const manifestPath = join(skillDirectory, "SKILL.md");
    const manifest = this.parser.parse(await readFile(manifestPath, "utf8"), {
      expectedDirectoryName: basename(skillDirectory)
    });
    const masked: string[] = [];
    const revisionHash = createHash("sha256");
    let readme: string | undefined;
    for (const path of files) {
      const relativePath = relative(skillDirectory, path).replaceAll("\\", "/");
      const raw = await readFile(path);
      revisionHash.update(relativePath, "utf8").update("\0", "utf8").update(raw);
      if (!this.isTextFile(relativePath) && raw.includes(0)) {
        continue;
      }
      const content = raw.toString("utf8");
      const result = this.guard.analyzeFile({ path: `skill/${manifest.name}/${relativePath}`, content });
      if (result.blocked || result.excluded || result.maskedContent === undefined) {
        throw new Error(`${relativePath} は安全性検査を通過しませんでした。`);
      }
      masked.push(`--- ${relativePath}\n${result.maskedContent}`);
      if (/^readme\.md$/i.test(relativePath)) {
        readme = result.maskedContent.slice(0, 128 * 1024);
      }
    }
    const combinedAuditContent = masked.join("\n");
    const auditedContent = this.truncateUtf8(combinedAuditContent, 96 * 1024);
    const revision = revisionHash.digest("hex");
    const candidate: PreparedSkillInstall = {
      id: randomUUID(),
      name: manifest.name,
      source: this.redactSource(source),
      directoryPath: skillDirectory,
      manifest,
      ...(readme ? { readme } : {}),
      auditedContent,
      revision,
      warnings: Buffer.byteLength(combinedAuditContent, "utf8") > Buffer.byteLength(auditedContent, "utf8")
        ? ["説明生成用の本文は96KiBで切り詰めました。全テキストファイルへのPrivacy Guard検査と全ファイルの改変検知は実施済みです。"]
        : []
    };
    if (remember) {
      this.prepared.set(candidate.id, candidate);
    }
    return candidate;
  }

  private async findSkillDirectory(root: string): Promise<string> {
    if (await this.exists(join(root, "SKILL.md"))) {
      return root;
    }
    const found: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4 || found.length > 1) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name === "SKILL.md") found.push(directory);
        if (entry.isDirectory()) await visit(path, depth + 1);
      }
    };
    await visit(root, 0);
    if (found.length !== 1 || !found[0]) {
      throw new Error(found.length === 0 ? "SKILL.mdが見つかりません。" : "複数のSkillがあります。URLのpathで1件を指定してください。");
    }
    return found[0];
  }

  private async files(root: string): Promise<string[]> {
    const result: string[] = [];
    let total = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        if (entry.isSymbolicLink()) throw new Error("シンボリックリンクを含むSkillはインストールできません。");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          const info = await stat(path);
          if (info.size > MAX_FILE_BYTES) throw new Error(`${entry.name} がファイルサイズ上限を超えています。`);
          total += info.size;
          result.push(path);
          if (result.length > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error("Skillがファイル数または合計容量の上限を超えています。");
        }
      }
    };
    await visit(root);
    return result.sort((left, right) => left.localeCompare(right));
  }

  private gitSource(raw: string): { readonly url: string; readonly ref?: string; readonly path?: string } {
    const [urlText, fragment = ""] = raw.trim().split("#", 2);
    const url = new URL(urlText ?? "");
    if (url.protocol !== "https:") throw new Error("Git取得元はHTTPS URLで指定してください。");
    if (url.username || url.password) throw new Error("認証情報入りURLは使用できません。認証情報を安全な保管先へ分離してください。");
    if (url.search) throw new Error("クエリ付きGit URLは認証情報を含む可能性があるため使用できません。refとpathは#以降へ指定してください。");
    const params = new URLSearchParams(fragment);
    const ref = params.get("ref");
    const path = params.get("path");
    return { url: url.toString(), ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
  }

  private redactSource(source: string): string {
    try {
      const sourceUrl = source.split("#", 1)[0];
      if (!sourceUrl) return source;
      const url = new URL(sourceUrl);
      if (url.username || url.password) {
        url.username = "***";
        url.password = "***";
      }
      return `${url.toString()}${source.includes("#") ? `#${source.split("#", 2)[1]}` : ""}`;
    } catch {
      return source;
    }
  }

  private isTextFile(path: string): boolean {
    return /(?:^|\/)(?:(?:SKILL|README)\.md|\.env(?:\..+)?|Dockerfile|Makefile)$/i.test(path) || /\.(?:md|txt|json|ya?ml|toml|html?|css|[cm]?[jt]sx?|py|sh|ps1)$/i.test(path);
  }

  private truncateUtf8(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let end = Math.min(value.length, maxBytes);
    while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
    return value.slice(0, end);
  }

  private within(parent: string, child: string): boolean {
    const value = relative(resolve(parent), resolve(child));
    return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? false : Promise.reject(error);
    }
  }
}
