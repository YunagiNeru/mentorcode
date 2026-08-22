import type { CustomInstructionReviewResult } from "../domain/customInstructionReview";
import type { CustomInstructionSaveStatus } from "./customInstructionEditorModel";

export type CustomInstructionReviewViewStatus =
  | "idle"
  | "saving"
  | "safety"
  | "llm"
  | "unavailable"
  | "complete"
  | "error";

export type CustomInstructionReviewFreshness = "none" | "current" | "stale";

export type CustomInstructionReviewPreparation = "save" | "review" | "none";

export interface CustomInstructionReviewEditorState {
  readonly draft: string;
  readonly revision: string;
  readonly saveStatus: CustomInstructionSaveStatus;
}

export class CustomInstructionReviewModel {
  public status: CustomInstructionReviewViewStatus = "idle";
  public message = "";
  public result: CustomInstructionReviewResult | undefined;
  public freshness: CustomInstructionReviewFreshness = "none";
  private reviewAfterSave = false;
  private activeDraft: string | undefined;
  private reviewedDraft: string | undefined;

  public prepare(editor: CustomInstructionReviewEditorState): CustomInstructionReviewPreparation {
    if (!editor.draft.trim()) {
      this.failCurrent("AGENTS.mdが空です。レビューする指示を入力してください。");
      return "none";
    }
    if (editor.saveStatus === "pending" || editor.saveStatus === "saving") {
      this.reviewAfterSave = true;
      this.activeDraft = undefined;
      this.status = "saving";
      this.message = "最新の内容を保存してからレビューを開始します。";
      return "save";
    }
    if (editor.saveStatus !== "saved") {
      this.failCurrent("AGENTS.mdの保存状態を解決してからレビューしてください。");
      return "none";
    }

    this.reviewAfterSave = false;
    this.activeDraft = editor.draft;
    this.status = "safety";
    this.message = "外部送信前の安全確認を実行しています。";
    return "review";
  }

  public shouldReviewAfterSave(saveStatus: CustomInstructionSaveStatus): boolean {
    return this.reviewAfterSave && saveStatus === "saved";
  }

  public saveFailed(): void {
    if (!this.reviewAfterSave) {
      return;
    }
    this.reviewAfterSave = false;
    this.failCurrent("保存に失敗したため、レビューを開始していません。");
  }

  public draftChanged(draft: string): void {
    this.reviewAfterSave = false;
    this.activeDraft = undefined;
    this.status = this.result ? "complete" : "idle";
    this.message = "";
    this.updateFreshness(draft);
  }

  public llmStarted(revision: string, currentRevision: string, currentDraft: string): boolean {
    if (!this.isCurrentRequest(revision, currentRevision, currentDraft)) {
      return false;
    }
    this.status = "llm";
    this.message = "カスタム指示をレビューしています。";
    return true;
  }

  public unavailable(
    revision: string,
    currentRevision: string,
    currentDraft: string,
    message: string
  ): boolean {
    if (!this.isCurrentRequest(revision, currentRevision, currentDraft)) {
      return false;
    }
    this.activeDraft = undefined;
    this.status = "unavailable";
    this.message = message;
    return true;
  }

  public complete(
    revision: string,
    currentRevision: string,
    currentDraft: string,
    result: CustomInstructionReviewResult
  ): boolean {
    if (!this.isCurrentRequest(revision, currentRevision, currentDraft) ||
      result.instructionRevision !== currentRevision) {
      return false;
    }
    this.activeDraft = undefined;
    this.result = result;
    this.reviewedDraft = currentDraft;
    this.freshness = "current";
    this.status = "complete";
    this.message = "";
    return true;
  }

  public fail(
    revision: string,
    currentRevision: string,
    currentDraft: string,
    message: string
  ): boolean {
    if (!this.isCurrentRequest(revision, currentRevision, currentDraft)) {
      return false;
    }
    this.failCurrent(message);
    return true;
  }

  public isActive(): boolean {
    return this.status === "saving" || this.status === "safety" || this.status === "llm";
  }

  private failCurrent(message: string): void {
    this.activeDraft = undefined;
    this.status = "error";
    this.message = message;
  }

  private isCurrentRequest(revision: string, currentRevision: string, currentDraft: string): boolean {
    return revision === currentRevision && this.activeDraft === currentDraft;
  }

  private updateFreshness(draft: string): void {
    if (!this.result || this.reviewedDraft === undefined) {
      this.freshness = "none";
      return;
    }
    this.freshness = draft === this.reviewedDraft ? "current" : "stale";
  }
}
