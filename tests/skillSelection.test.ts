import { describe, expect, it } from "vitest";
import {
  MAX_SELECTED_SKILLS,
  SkillSelectionParser,
  isSkillSelectionRequest
} from "../src/domain/skills/skillSelection";
import type { SkillCatalogEntry } from "../src/domain/skills/skillCatalog";

const catalog: readonly SkillCatalogEntry[] = [
  {
    id: "workspace:one:testing",
    name: "testing",
    description: "テスト実行と失敗分析を支援します。",
    scope: "workspace"
  },
  {
    id: "user:global:docs",
    name: "docs",
    description: "技術文書の作成を支援します。",
    scope: "user"
  }
];

describe("SkillSelection", () => {
  it("accepts a bounded unique catalog", () => {
    expect(isSkillSelectionRequest({ task: "テストを直して", catalog })).toBe(true);
    expect(isSkillSelectionRequest({ task: "", catalog })).toBe(false);
    expect(isSkillSelectionRequest({ task: "テスト", catalog: [...catalog, catalog[0]] })).toBe(false);
  });

  it("keeps only unique allowlisted ids", () => {
    const parser = new SkillSelectionParser();
    expect(parser.parse(JSON.stringify({
      selectedIds: [catalog[0]?.id, "unknown", catalog[0]?.id, catalog[1]?.id]
    }), catalog)).toEqual({
      selectedIds: [catalog[0]?.id, catalog[1]?.id]
    });
  });

  it("fails closed for malformed output and bounds selections", () => {
    const expanded = Array.from({ length: MAX_SELECTED_SKILLS + 2 }, (_, index) => ({
      id: `workspace:one:skill-${index}`,
      name: `skill-${index}`,
      description: `Skill ${index}`,
      scope: "workspace" as const
    }));
    const parser = new SkillSelectionParser();
    expect(parser.parse("not json", expanded)).toEqual({ selectedIds: [] });
    expect(parser.parse(JSON.stringify({ selectedIds: expanded.map((entry) => entry.id) }), expanded).selectedIds)
      .toHaveLength(MAX_SELECTED_SKILLS);
  });
});
