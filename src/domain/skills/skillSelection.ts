import type { SkillCatalogEntry } from "./skillCatalog";

export const MAX_SKILL_SELECTION_CANDIDATES = 128;
export const MAX_SELECTED_SKILLS = 4;
export const MAX_SKILL_SELECTION_TASK_BYTES = 64 * 1024;

export interface SkillSelectionRequest {
  readonly task: string;
  readonly catalog: readonly SkillCatalogEntry[];
}

export interface SkillSelectionResult {
  readonly selectedIds: readonly string[];
}

export function isSkillSelectionRequest(value: unknown): value is SkillSelectionRequest {
  if (!isRecord(value) || typeof value.task !== "string" || !Array.isArray(value.catalog)) {
    return false;
  }
  if (value.task.trim().length === 0 || Buffer.byteLength(value.task, "utf8") > MAX_SKILL_SELECTION_TASK_BYTES) {
    return false;
  }
  if (value.catalog.length === 0 || value.catalog.length > MAX_SKILL_SELECTION_CANDIDATES) {
    return false;
  }
  if (!value.catalog.every(isSkillCatalogEntry)) {
    return false;
  }
  return new Set(value.catalog.map((entry) => entry.id)).size === value.catalog.length;
}

export class SkillSelectionParser {
  public parse(text: string, catalog: readonly SkillCatalogEntry[]): SkillSelectionResult {
    let value: unknown;
    try {
      value = JSON.parse(this.extractJsonObject(text));
    } catch {
      return { selectedIds: [] };
    }
    if (!isRecord(value) || !Array.isArray(value.selectedIds)) {
      return { selectedIds: [] };
    }

    const allowedIds = new Set(catalog.map((entry) => entry.id));
    const selectedIds: string[] = [];
    for (const id of value.selectedIds) {
      if (typeof id !== "string" || !allowedIds.has(id) || selectedIds.includes(id)) {
        continue;
      }
      selectedIds.push(id);
      if (selectedIds.length === MAX_SELECTED_SKILLS) {
        break;
      }
    }
    return { selectedIds };
  }

  private extractJsonObject(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed;
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  }
}

function isSkillCatalogEntry(value: unknown): value is SkillCatalogEntry {
  return isRecord(value) &&
    typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 &&
    typeof value.name === "string" && value.name.length > 0 && value.name.length <= 64 &&
    typeof value.description === "string" && value.description.length > 0 && value.description.length <= 1024 &&
    (value.scope === "workspace" || value.scope === "user") &&
    (value.compatibility === undefined ||
      (typeof value.compatibility === "string" && value.compatibility.length <= 500));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
