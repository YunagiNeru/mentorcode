import { describe, expect, it } from "vitest";
import { CustomInstructionReviewModel } from "../src/webview/customInstructionReviewModel";
import {
  validCustomInstructionReviewRequest,
  validCustomInstructionReviewResult
} from "./fixtures/customInstructionReview";

describe("CustomInstructionReviewModel", () => {
  it("waits for autosave before requesting a review", () => {
    const model = new CustomInstructionReviewModel();

    expect(model.prepare({
      draft: "日本語で回答する。",
      revision: "old",
      saveStatus: "pending"
    })).toBe("save");
    expect(model.status).toBe("saving");
    expect(model.shouldReviewAfterSave("saved")).toBe(true);
    expect(model.prepare({
      draft: "日本語で回答する。",
      revision: "new",
      saveStatus: "saved"
    })).toBe("review");
    expect(model.status).toBe("safety");
    expect(model.message).toContain("安全確認");
  });

  it("rejects stale results without replacing the current state", () => {
    const model = new CustomInstructionReviewModel();
    model.prepare({ draft: "日本語で回答する。", revision: "current", saveStatus: "saved" });
    const request = validCustomInstructionReviewRequest();

    expect(model.complete(
      "old",
      "current",
      request.customInstruction.content,
      validCustomInstructionReviewResult(request)
    )).toBe(false);
    expect(model.result).toBeUndefined();
    expect(model.status).toBe("safety");
  });

  it("shows a concise unavailable state without synthetic fallback findings", () => {
    const model = new CustomInstructionReviewModel();
    model.prepare({ draft: "日本語で回答する。", revision: "current", saveStatus: "saved" });

    expect(model.unavailable(
      "current",
      "current",
      "日本語で回答する。",
      "安全確認を完了できませんでした。"
    )).toBe(true);
    expect(model.status).toBe("unavailable");
    expect(model.result).toBeUndefined();
    expect(model.message).toBe("安全確認を完了できませんでした。");
  });

  it("keeps a completed review visible and marks it stale while the draft is edited", () => {
    const model = new CustomInstructionReviewModel();
    const request = validCustomInstructionReviewRequest();
    const draft = request.customInstruction.content;
    const result = validCustomInstructionReviewResult(request);

    model.prepare({ draft, revision: request.instructionRevision, saveStatus: "saved" });
    expect(model.complete(
      request.instructionRevision,
      request.instructionRevision,
      draft,
      result
    )).toBe(true);

    model.draftChanged(`${draft}\n完了条件を追記する。`);
    expect(model.result).toBe(result);
    expect(model.status).toBe("complete");
    expect(model.freshness).toBe("stale");

    model.draftChanged(draft);
    expect(model.result).toBe(result);
    expect(model.freshness).toBe("current");
  });

  it("rejects a review response when the draft changed before autosave updated the revision", () => {
    const model = new CustomInstructionReviewModel();
    const request = validCustomInstructionReviewRequest();
    const draft = request.customInstruction.content;

    model.prepare({ draft, revision: request.instructionRevision, saveStatus: "saved" });
    model.draftChanged(`${draft}\n編集後の内容`);

    expect(model.complete(
      request.instructionRevision,
      request.instructionRevision,
      `${draft}\n編集後の内容`,
      validCustomInstructionReviewResult(request)
    )).toBe(false);
    expect(model.result).toBeUndefined();
    expect(model.status).toBe("idle");
  });

  it("keeps the previous review when a re-review fails", () => {
    const model = new CustomInstructionReviewModel();
    const previousRequest = validCustomInstructionReviewRequest();
    const previousDraft = previousRequest.customInstruction.content;
    const previousResult = validCustomInstructionReviewResult(previousRequest);

    model.prepare({
      draft: previousDraft,
      revision: previousRequest.instructionRevision,
      saveStatus: "saved"
    });
    model.complete(
      previousRequest.instructionRevision,
      previousRequest.instructionRevision,
      previousDraft,
      previousResult
    );

    const currentRequest = validCustomInstructionReviewRequest(`${previousDraft}\n完了条件を追記する。`);
    const currentDraft = currentRequest.customInstruction.content;
    model.draftChanged(currentDraft);
    model.prepare({
      draft: currentDraft,
      revision: currentRequest.instructionRevision,
      saveStatus: "saved"
    });

    expect(model.fail(
      currentRequest.instructionRevision,
      currentRequest.instructionRevision,
      currentDraft,
      "レビューに失敗しました。"
    )).toBe(true);
    expect(model.result).toBe(previousResult);
    expect(model.freshness).toBe("stale");
    expect(model.status).toBe("error");
  });

  it("keeps the previous result during re-review and replaces it only after completion", () => {
    const model = new CustomInstructionReviewModel();
    const previousRequest = validCustomInstructionReviewRequest();
    const previousDraft = previousRequest.customInstruction.content;
    const previousResult = validCustomInstructionReviewResult(previousRequest);

    model.prepare({
      draft: previousDraft,
      revision: previousRequest.instructionRevision,
      saveStatus: "saved"
    });
    model.complete(
      previousRequest.instructionRevision,
      previousRequest.instructionRevision,
      previousDraft,
      previousResult
    );

    const currentRequest = validCustomInstructionReviewRequest(`${previousDraft}\n完了条件を追記する。`);
    const currentDraft = currentRequest.customInstruction.content;
    const currentResult = validCustomInstructionReviewResult(currentRequest);
    model.draftChanged(currentDraft);

    expect(model.prepare({
      draft: currentDraft,
      revision: currentRequest.instructionRevision,
      saveStatus: "saved"
    })).toBe("review");
    expect(model.result).toBe(previousResult);
    expect(model.freshness).toBe("stale");
    expect(model.status).toBe("safety");

    expect(model.complete(
      currentRequest.instructionRevision,
      currentRequest.instructionRevision,
      currentDraft,
      currentResult
    )).toBe(true);
    expect(model.result).toBe(currentResult);
    expect(model.freshness).toBe("current");
    expect(model.status).toBe("complete");
  });
});
