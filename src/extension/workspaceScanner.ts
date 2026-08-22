import * as vscode from "vscode";
import {
  MentorContextPolicy,
  type MentorContextBudgetExclusion
} from "../domain/mentor/contextPolicy";
import type {
  ContextPackage,
  FileCandidate,
  MentorContextSource,
  MentorRequest,
  WorkspaceMap
} from "../domain/types";
import { PrivacyGuard } from "../domain/privacy/privacyGuard";
import { WorkspaceMapBuilder } from "../domain/workspace/workspaceMap";
import { BonsaiProjectReviewer } from "../localLlm/bonsaiProjectReviewer";

export interface WorkspaceScanResult {
  readonly contextPackage: ContextPackage;
  readonly workspaceMap: WorkspaceMap;
  readonly workspaceTrusted: boolean;
  readonly rootName: string;
}

export interface WorkspaceReference {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export class WorkspaceScanner {
  private readonly mapBuilder = new WorkspaceMapBuilder();
  private readonly contextPolicy = new MentorContextPolicy();

  public constructor(
    private readonly guard: PrivacyGuard,
    private readonly projectReviewer?: BonsaiProjectReviewer
  ) {}

  public async scan(): Promise<WorkspaceScanResult> {
    const workspaceFolder = this.workspaceFolder();
    const configuration = vscode.workspace.getConfiguration("mentorCode");
    const maxFiles = configuration.get<number>("maxFiles", 200);
    const maxFileBytes = configuration.get<number>("maxFileBytes", 120_000);

    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/.cache/**}",
      maxFiles
    );

    const candidates: FileCandidate[] = [];
    for (const uri of uris) {
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const stat = await vscode.workspace.fs.stat(uri);

      if (stat.size > maxFileBytes) {
        candidates.push({
          path: relativePath,
          content: "",
          sizeBytes: stat.size,
          contextSource: "workspace_scan",
          sourceSizeBytes: stat.size,
          includedSizeBytes: 0,
          contentComplete: false
        });
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      candidates.push({
        path: relativePath,
        content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        sizeBytes: stat.size,
        contextSource: "workspace_scan",
        sourceSizeBytes: stat.size,
        includedSizeBytes: bytes.byteLength,
        contentComplete: true
      });
    }

    const reviewContextPackage = new PrivacyGuard({
      maxFileBytes
    }).createContextPackage(candidates);
    const reviewWorkspaceMap = this.mapBuilder.build(reviewContextPackage);
    const projectReview = this.projectReviewer
      ? await this.projectReviewer.review({
        rootName: workspaceFolder.name,
        contextPackage: reviewContextPackage,
        workspaceMap: reviewWorkspaceMap
      })
      : undefined;

    const mentorLimits = this.contextPolicy.limits(maxFiles, maxFileBytes);
    const mentorBudget = this.contextPolicy.applyTotalBudget(candidates, mentorLimits.maxTotalBytes);
    const contextPackage = this.withContextMetadata(
      await this.guard.createContextPackageAsync(mentorBudget.candidates),
      mentorBudget.candidates,
      mentorBudget.exclusions
    );
    const contextPackageWithReview: ContextPackage = {
      ...contextPackage,
      ...(projectReview ? { projectReview } : {})
    };
    return {
      contextPackage: contextPackageWithReview,
      workspaceMap: this.mapBuilder.build(contextPackageWithReview),
      workspaceTrusted: vscode.workspace.isTrusted,
      rootName: workspaceFolder.name
    };
  }

  public async collectMentorContext(
    request: MentorRequest,
    references: readonly WorkspaceReference[] = []
  ): Promise<WorkspaceScanResult> {
    const workspaceFolder = this.workspaceFolder();
    const configuration = vscode.workspace.getConfiguration("mentorCode");
    const maxConfiguredFiles = configuration.get<number>("maxFiles", 200);
    const maxConfiguredBytes = configuration.get<number>("maxFileBytes", 120_000);
    const limits = this.contextPolicy.limits(maxConfiguredFiles, maxConfiguredBytes);
    const referenceCandidates = references.length > 0
      ? await this.candidatesFromReferences(workspaceFolder, references, limits.maxFiles, limits.maxFileBytes)
      : [];
    const projectCandidates = await this.candidatesFromTaskSearch(
      workspaceFolder,
      request,
      limits.maxFiles,
      limits.maxFileBytes
    );
    const candidates = this.mergeCandidates(referenceCandidates, projectCandidates, limits.maxFiles);
    const budget = this.contextPolicy.applyTotalBudget(candidates, limits.maxTotalBytes);
    const contextPackage = this.withContextMetadata(
      await this.guard.createContextPackageAsync(budget.candidates),
      budget.candidates,
      budget.exclusions
    );

    return {
      contextPackage,
      workspaceMap: this.mapBuilder.build(contextPackage),
      workspaceTrusted: vscode.workspace.isTrusted,
      rootName: workspaceFolder.name
    };
  }

  public async listReferences(query: string, limit = 30): Promise<readonly WorkspaceReference[]> {
    this.workspaceFolder();
    const normalizedQuery = this.normalizeReferencePath(query).toLowerCase();
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/.cache/**}",
      500
    );
    const items = new Map<string, WorkspaceReference>();

    for (const uri of uris) {
      const relativePath = this.normalizeReferencePath(vscode.workspace.asRelativePath(uri, false));
      this.addReferenceCandidate(items, relativePath, "file", normalizedQuery);

      const parts = relativePath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        this.addReferenceCandidate(items, parts.slice(0, index).join("/"), "directory", normalizedQuery);
      }
    }

    return [...items.values()]
      .sort((left, right) => this.referenceScore(right, normalizedQuery) - this.referenceScore(left, normalizedQuery) || left.path.localeCompare(right.path))
      .slice(0, limit);
  }

  private workspaceFolder(): vscode.WorkspaceFolder {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("ワークスペースが開かれていません。");
    }

    return workspaceFolder;
  }

  private async candidatesFromReferences(
    workspaceFolder: vscode.WorkspaceFolder,
    references: readonly WorkspaceReference[],
    maxFiles: number,
    maxFileBytes: number
  ): Promise<readonly FileCandidate[]> {
    const candidates: FileCandidate[] = [];
    const seen = new Set<string>();

    for (const reference of references) {
      if (candidates.length >= maxFiles) {
        break;
      }

      const normalized = this.normalizeReferencePath(reference.path);
      if (!this.isSafeRelativeReference(normalized)) {
        continue;
      }

      if (reference.kind === "directory") {
        const uris = await vscode.workspace.findFiles(
          `${normalized}/**/*`,
          "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/.cache/**}",
          maxFiles - candidates.length
        );
        for (const uri of uris) {
          await this.pushCandidate(candidates, seen, uri, maxFileBytes, "explicit_reference");
          if (candidates.length >= maxFiles) {
            break;
          }
        }
        continue;
      }

      await this.pushCandidate(
        candidates,
        seen,
        vscode.Uri.joinPath(workspaceFolder.uri, normalized),
        maxFileBytes,
        "explicit_reference"
      );
    }

    return candidates;
  }

  private mergeCandidates(
    primary: readonly FileCandidate[],
    secondary: readonly FileCandidate[],
    limit: number
  ): readonly FileCandidate[] {
    const merged: FileCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of [...primary, ...secondary]) {
      const normalized = this.normalizeReferencePath(candidate.path);
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(candidate);
      if (merged.length >= limit) {
        break;
      }
    }

    return merged;
  }

  private async candidatesFromTaskSearch(
    workspaceFolder: vscode.WorkspaceFolder,
    request: MentorRequest,
    maxFiles: number,
    maxFileBytes: number
  ): Promise<readonly FileCandidate[]> {
    const terms = this.searchTerms(request);
    const requestedPaths = this.requestedPaths(request);
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/node_modules/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/.cache/**}",
      300
    );
    const scored: { readonly score: number; readonly candidate: FileCandidate }[] = [];

    for (const uri of uris) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxFileBytes) {
        continue;
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const relativePath = this.normalizeReferencePath(vscode.workspace.asRelativePath(uri, false));
      const score = this.contextScore(relativePath, content, terms, requestedPaths);
      if (score <= 0) {
        continue;
      }

      scored.push({
        score,
        candidate: {
          path: relativePath,
          content,
          sizeBytes: stat.size,
          contextSource: "task_discovery",
          sourceSizeBytes: stat.size,
          includedSizeBytes: bytes.byteLength,
          contentComplete: true
        }
      });
    }

    if (scored.length === 0) {
      const readmeUri = vscode.Uri.joinPath(workspaceFolder.uri, "README.md");
      const readme = await this.readCandidate(readmeUri, maxFileBytes, "task_discovery");
      return readme ? [readme] : [];
    }

    return scored
      .sort((left, right) => right.score - left.score || left.candidate.path.localeCompare(right.candidate.path))
      .slice(0, maxFiles)
      .map((item) => item.candidate);
  }

  private async pushCandidate(
    candidates: FileCandidate[],
    seen: Set<string>,
    uri: vscode.Uri,
    maxFileBytes: number,
    contextSource: MentorContextSource
  ): Promise<void> {
    const relativePath = this.normalizeReferencePath(vscode.workspace.asRelativePath(uri, false));
    if (seen.has(relativePath)) {
      return;
    }

    const candidate = await this.readCandidate(uri, maxFileBytes, contextSource);
    if (!candidate) {
      return;
    }

    seen.add(relativePath);
    candidates.push(candidate);
  }

  private async readCandidate(
    uri: vscode.Uri,
    maxFileBytes: number,
    contextSource: MentorContextSource
  ): Promise<FileCandidate | undefined> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }

    if (stat.type !== vscode.FileType.File) {
      return undefined;
    }

    const relativePath = this.normalizeReferencePath(vscode.workspace.asRelativePath(uri, false));
    if (stat.size > maxFileBytes) {
      return {
        path: relativePath,
        content: "",
        sizeBytes: stat.size,
        contextSource,
        sourceSizeBytes: stat.size,
        includedSizeBytes: 0,
        contentComplete: false
      };
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      path: relativePath,
      content: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      sizeBytes: stat.size,
      contextSource,
      sourceSizeBytes: stat.size,
      includedSizeBytes: bytes.byteLength,
      contentComplete: true
    };
  }

  private withContextMetadata(
    contextPackage: ContextPackage,
    candidates: readonly FileCandidate[],
    budgetExclusions: readonly MentorContextBudgetExclusion[] = []
  ): ContextPackage {
    const candidateByPath = new Map(
      candidates.map((candidate) => [this.normalizeReferencePath(candidate.path), candidate] as const)
    );
    const metadataFor = (path: string) => {
      const candidate = candidateByPath.get(this.normalizeReferencePath(path));
      if (!candidate) {
        return {};
      }

      return {
        ...(candidate.contextSource ? { contextSource: candidate.contextSource } : {}),
        ...(candidate.sourceSizeBytes === undefined ? {} : { sourceSizeBytes: candidate.sourceSizeBytes }),
        ...(candidate.includedSizeBytes === undefined ? {} : { includedSizeBytes: candidate.includedSizeBytes }),
        ...(candidate.contentComplete === undefined ? {} : { contentComplete: candidate.contentComplete })
      };
    };

    return {
      ...contextPackage,
      files: contextPackage.files.map((file) => ({
        ...file,
        ...metadataFor(file.path)
      })),
      blockedFiles: [
        ...contextPackage.blockedFiles.map((file) => ({
          ...file,
          ...metadataFor(file.path)
        })),
        ...budgetExclusions
      ],
      summary: {
        ...contextPackage.summary,
        scannedFiles: contextPackage.summary.scannedFiles + budgetExclusions.length,
        blockedFiles: contextPackage.summary.blockedFiles + budgetExclusions.length
      }
    };
  }

  private addReferenceCandidate(
    items: Map<string, WorkspaceReference>,
    path: string,
    kind: WorkspaceReference["kind"],
    query: string
  ): void {
    if (items.has(path)) {
      return;
    }

    if (query && !path.toLowerCase().includes(query)) {
      return;
    }

    items.set(path, {
      path,
      kind
    });
  }

  private referenceScore(reference: WorkspaceReference, query: string): number {
    const path = reference.path.toLowerCase();
    let score = reference.kind === "directory" ? 3 : 1;
    if (query && path === query) {
      score += 20;
    }
    if (query && path.endsWith(`/${query}`)) {
      score += 12;
    }
    if (query && path.includes(query)) {
      score += 6;
    }

    return score;
  }

  private contextScore(
    path: string,
    content: string,
    terms: readonly string[],
    requestedPaths: readonly string[]
  ): number {
    const normalizedPath = path.toLowerCase();
    const normalizedContent = content.toLowerCase();
    let score = 0;

    for (const requestedPath of requestedPaths) {
      if (normalizedPath === requestedPath || normalizedPath.endsWith(`/${requestedPath}`)) {
        score += 100;
      }
    }

    for (const term of terms) {
      if (normalizedPath.includes(term)) {
        score += 12;
      }
      if (normalizedContent.includes(term)) {
        score += 4;
      }
    }

    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|swift|go|rs|php|rb|cs)$/.test(normalizedPath)) {
      score += 8;
    }
    if (/(^|\/)(src|app|lib)\//.test(normalizedPath)) {
      score += 5;
    }
    if (/(^|\/)(index|main|app|server|config)\./.test(normalizedPath)) {
      score += 3;
    }

    return score;
  }

  private searchTerms(request: MentorRequest): readonly string[] {
    const source = request.task;
    const terms = new Set<string>();
    for (const match of source.matchAll(/[A-Za-z0-9_.-]{3,}/g)) {
      const term = match[0].toLowerCase();
      if (!/^(the|and|for|with|this|that|http|https|src|app|review|plan)$/.test(term)) {
        terms.add(term);
      }
    }

    return [...terms].slice(0, 20);
  }

  private requestedPaths(request: MentorRequest): readonly string[] {
    const source = request.task;
    const paths = new Set<string>();
    for (const match of source.matchAll(/(?:^|[\s"'(:@])((?:[\w.-]+[\\/])+[\w.-]+(?:\.[\w.-]+)?)(?=$|[\s"',):;])/g)) {
      const path = this.normalizeReferencePath(match[1] ?? "").toLowerCase();
      if (this.isSafeRelativeReference(path)) {
        paths.add(path);
      }
    }

    return [...paths];
  }

  private normalizeReferencePath(path: string): string {
    return path
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .replace(/^@/, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/g, "");
  }

  private isSafeRelativeReference(path: string): boolean {
    return path.length > 0 && !path.startsWith("/") && !path.includes("..");
  }
}
