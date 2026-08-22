import { describe, expect, it } from "vitest";
import type { MentorPatchToolCall } from "../src/domain/types";
import { patchToolCallToEditPreview } from "../src/domain/agent/toolCalls";

const patch = [
  "*** Begin Patch",
  "*** Add File: src/new.ts",
  "+export const created = true;",
  "*** Update File: src/current.ts",
  "@@",
  "-export const value = 1;",
  "+export const value = 2;",
  "*** Delete File: src/old.ts",
  "*** End Patch"
].join("\n");

describe("patchToolCallToEditPreview", () => {
  it("maps each LLM explanation to its matching file operation", () => {
    const toolCall: MentorPatchToolCall = {
      type: "apply_patch",
      intent: "関連ファイルを整理します。",
      patch,
      fileExplanations: [
        {
          path: "src/new.ts",
          explanation: "新しい値の提供元を分離するために追加します。この変更により、利用側が共通の値を参照できます。"
        },
        {
          path: "src/current.ts",
          explanation: "現在値を新しい仕様へ合わせるために更新します。この変更により、既存の参照結果が新仕様へ切り替わります。"
        },
        {
          path: "src/old.ts",
          explanation: "重複した提供元をなくすために削除します。この変更により、古い値を誤って参照できなくなります。"
        }
      ]
    };

    expect(patchToolCallToEditPreview(toolCall).operations.map((operation) => ({
      path: operation.path,
      explanation: operation.explanation
    }))).toEqual(toolCall.fileExplanations);
  });

  it("falls back to the patch intent for stored responses without per-file explanations", () => {
    const preview = patchToolCallToEditPreview({
      type: "apply_patch",
      intent: "関連ファイルを整理し、参照先を一本化します。",
      patch
    });

    expect(preview.operations.every((operation) =>
      operation.explanation === "関連ファイルを整理し、参照先を一本化します。"
    )).toBe(true);
  });
});
