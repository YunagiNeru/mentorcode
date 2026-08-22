export interface ReferenceLike {
  readonly path: string;
}

export interface WorkspaceFileMentionSegment {
  readonly text: string;
  readonly filePath?: string;
}

const FILE_MENTION_PATTERN = /@?(?:(?:[A-Za-z0-9_.-]+[\\/])+)?(?:[A-Za-z0-9_-][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+|\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|Dockerfile|Makefile|README|LICENSE|CHANGELOG|NOTICE|COPYING|Procfile)/g;

const COMMON_WORKSPACE_FILE_EXTENSIONS = new Set([
  "bat",
  "c",
  "cmd",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "gradle",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "lock",
  "md",
  "mjs",
  "php",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml"
]);

const SPECIAL_WORKSPACE_FILENAMES = new Set([
  "changelog",
  "copying",
  "dockerfile",
  "license",
  "makefile",
  "notice",
  "procfile",
  "readme"
]);

export function filterMentionedReferences<T extends ReferenceLike>(
  references: readonly T[],
  text: string
): readonly T[] {
  return references.filter((reference) => containsReferenceMention(text, reference.path));
}

export function containsReferenceMention(text: string, path: string): boolean {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\s)@${escapedPath}(?=\\s|$)`);
  return pattern.test(text);
}

export function splitWorkspaceFileMentions(text: string): readonly WorkspaceFileMentionSegment[] {
  const segments: WorkspaceFileMentionSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(FILE_MENTION_PATTERN)) {
    const matchedText = match[0];
    const index = match.index;
    if (index === undefined || !matchedText) {
      continue;
    }

    if (!hasMentionBoundary(text, index, matchedText.length)) {
      continue;
    }

    const filePath = normalizeWorkspaceFileMention(matchedText);
    if (!filePath || !isLikelyWorkspaceFileMention(filePath)) {
      continue;
    }

    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index) });
    }
    segments.push({
      text: matchedText,
      filePath
    });
    cursor = index + matchedText.length;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

function normalizeWorkspaceFileMention(text: string): string | undefined {
  const normalized = text
    .trim()
    .replace(/^@/, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/g, "");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("://") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }

  return normalized;
}

function hasMentionBoundary(text: string, start: number, length: number): boolean {
  return isBoundaryCharacter(text[start - 1]) && isBoundaryCharacter(text[start + length]);
}

function isBoundaryCharacter(character: string | undefined): boolean {
  if (character === undefined || character === "") {
    return true;
  }

  return /[\s"'`([{<:;,、。，．!?！？）)\]}>「」『』【】]/.test(character) || character.charCodeAt(0) > 127;
}

function isLikelyWorkspaceFileMention(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const basename = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  if (!basename) {
    return false;
  }

  if (isSpecialWorkspaceFilename(basename)) {
    return true;
  }

  if (basename.startsWith(".") && /^[a-z0-9._-]+$/.test(basename.slice(1))) {
    return true;
  }

  const extension = basename.split(".").at(-1);
  if (!extension || extension === basename) {
    return false;
  }

  if (normalized.includes("/")) {
    return extension.length <= 16;
  }

  return COMMON_WORKSPACE_FILE_EXTENSIONS.has(extension);
}

function isSpecialWorkspaceFilename(basename: string): boolean {
  const firstSegment = basename.split(".")[0] ?? "";
  return SPECIAL_WORKSPACE_FILENAMES.has(basename) || SPECIAL_WORKSPACE_FILENAMES.has(firstSegment);
}
