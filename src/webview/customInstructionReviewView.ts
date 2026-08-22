import type { CustomInstructionReviewResult } from "../domain/customInstructionReview";
import { ElementFactory } from "./components";
import type {
  CustomInstructionReviewFreshness,
  CustomInstructionReviewViewStatus
} from "./customInstructionReviewModel";

export interface CustomInstructionReviewViewState {
  readonly status: CustomInstructionReviewViewStatus;
  readonly message: string;
  readonly freshness: CustomInstructionReviewFreshness;
  readonly result?: CustomInstructionReviewResult;
}

export class CustomInstructionReviewView {
  public constructor(private readonly factory: ElementFactory) {}

  public render(slot: HTMLElement, state: CustomInstructionReviewViewState): void {
    this.factory.clear(slot);
    if (state.status === "idle" && !state.result) {
      return;
    }

    const panel = this.factory.element(
      "section",
      [
        "custom-instruction-review-panel",
        `custom-instruction-review-panel-${state.status}`,
        `custom-instruction-review-panel-${state.freshness}`
      ].join(" ")
    );
    panel.append(this.factory.element(
      "h3",
      "custom-instruction-review-title",
      this.statusLabel(state.status, state.freshness, Boolean(state.result))
    ));
    if (state.result && state.freshness === "stale") {
      panel.append(this.factory.element(
        "p",
        "custom-instruction-review-stale-note",
        "このレビューは編集前の内容に対する結果です。行番号もレビュー実行時点を参照しています。"
      ));
    }
    if (state.message) {
      panel.append(this.factory.element("p", "custom-instruction-review-message", state.message));
    }
    if (state.result) {
      panel.append(this.renderResult(state.result));
    }
    slot.append(panel);
  }

  private renderResult(result: CustomInstructionReviewResult): HTMLElement {
    const container = this.factory.element("div", "custom-instruction-review-llm");
    container.append(this.factory.element(
      "p",
      "custom-instruction-review-message",
      result.review.summary
    ));

    if (result.review.comments.length === 0) {
      return container;
    }

    const list = this.factory.element("ul", "custom-instruction-review-list");
    for (const comment of result.review.comments) {
      const item = this.factory.element("li", "custom-instruction-review-item");
      item.append(this.factory.element("span", "custom-instruction-review-item-text", comment));
      list.append(item);
    }
    container.append(list);
    return container;
  }

  private statusLabel(
    status: CustomInstructionReviewViewStatus,
    freshness: CustomInstructionReviewFreshness,
    hasResult: boolean
  ): string {
    if (hasResult) {
      if (status === "saving" || status === "safety") {
        return "再レビューの準備中";
      }
      if (status === "llm") {
        return "再レビュー中";
      }
      if (status === "unavailable") {
        return "再レビューを開始できません";
      }
      if (status === "error") {
        return "再レビュー失敗";
      }
      if (freshness === "stale") {
        return "編集前の内容に対するレビュー";
      }
    }
    const labels: Record<CustomInstructionReviewViewStatus, string> = {
      idle: "",
      saving: "保存完了を待っています",
      safety: "安全確認中",
      llm: "レビュー中",
      unavailable: "レビューを開始できません",
      complete: "レビュー結果",
      error: "レビュー失敗"
    };
    return labels[status];
  }
}
