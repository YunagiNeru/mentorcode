import type {
  CommandApprovalCard,
  ContextPackage,
  LocalLlmReview,
  MentorMcpToolCall,
  MentorPatchPreview,
  MentorResponse,
  MentorWorkspaceOperation,
  WorkspaceMap
} from "../domain/types";
import { patchToolCall, patchToolCallToEditPreview } from "../domain/agent/toolCalls";
import { splitWorkspaceFileMentions } from "./referenceMentions";
import type { HighlightedCode, HighlightedToken, SyntaxHighlighter, SyntaxHighlightTheme } from "./syntaxHighlight";

type NativeHtmlTagName = {
  [K in keyof HTMLElementTagNameMap]: HTMLElementTagNameMap[K] extends HTMLElement ? K : never;
}[keyof HTMLElementTagNameMap];
type SyntaxHighlightModule = typeof import("./syntaxHighlight");
export type OpenWorkspaceFileHandler = (path: string) => void;
export type CopyTextHandler = (text: string) => Promise<void>;

const PHOSPHOR_ICON_WEIGHT = "light";
const CODE_COPY_ICON_SIZE = 16;

let syntaxHighlightModulePromise: Promise<SyntaxHighlightModule> | undefined;
let syntaxHighlighter: SyntaxHighlighter | undefined;

export class ElementFactory {
  public element<K extends NativeHtmlTagName>(
    tag: K,
    className?: string,
    text?: string
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  public button(label: string, className = "", title?: string): HTMLButtonElement {
    const button = this.element("button", className, label);
    button.type = "button";
    if (title) {
      button.title = title;
      button.setAttribute("aria-label", title);
    }
    return button;
  }

  public phosphorIcon(tagName: string, className: string, size: number): HTMLElement {
    const icon = document.createElement(tagName);
    icon.className = className;
    icon.setAttribute("size", String(size));
    icon.setAttribute("weight", PHOSPHOR_ICON_WEIGHT);
    icon.setAttribute("color", "currentColor");
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  public clear(element: HTMLElement): void {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }
}

export class WorkspaceFileTextRenderer {
  public constructor(
    private readonly factory: ElementFactory,
    private readonly openWorkspaceFile: OpenWorkspaceFileHandler
  ) {}

  public render<K extends NativeHtmlTagName>(
    tag: K,
    className: string | undefined,
    text: string
  ): HTMLElementTagNameMap[K] {
    const element = this.factory.element(tag, className);
    this.append(element, text);
    return element;
  }

  public renderInline(text: string): HTMLSpanElement {
    return this.render("span", "linked-text", text);
  }

  public append(container: HTMLElement, text: string): void {
    for (const segment of splitWorkspaceFileMentions(text)) {
      if (segment.filePath) {
        container.append(this.renderFileLink(segment.text, segment.filePath));
        continue;
      }
      container.append(document.createTextNode(segment.text));
    }
  }

  private renderFileLink(text: string, filePath: string): HTMLButtonElement {
    const link = this.factory.button(text, "workspace-file-link", `ファイルを開く: ${filePath}`);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openWorkspaceFile(filePath);
    });
    return link;
  }
}

class CodePreviewRenderer {
  public constructor(
    private readonly factory: ElementFactory,
    private readonly copyText?: CopyTextHandler
  ) {}

  public render(
    code: string,
    options: { readonly className?: string; readonly sourcePath?: string } = {}
  ): HTMLElement {
    const className = ["code-preview", options.className].filter(Boolean).join(" ");
    const preview = this.factory.element("pre", className);
    preview.textContent = code;
    void this.applyHighlight(preview, code, options.sourcePath).catch((error: unknown) => {
      this.markHighlightFailed(preview, error);
    });

    if (!this.copyText) {
      return preview;
    }

    const block = this.factory.element("div", "code-block");
    const toolbar = this.factory.element("div", "code-block-toolbar");
    const copyButton = this.factory.button("", "code-copy-button", "コードをコピー");
    copyButton.setAttribute("aria-live", "polite");
    this.renderCopyButtonState(copyButton, "idle");
    copyButton.addEventListener("click", () => {
      void this.copyCode(copyButton, code);
    });
    toolbar.append(copyButton);
    block.append(toolbar, preview);
    return block;
  }

  private async copyCode(button: HTMLButtonElement, code: string): Promise<void> {
    if (!this.copyText) {
      return;
    }

    button.disabled = true;
    button.dataset.state = "copying";
    this.renderCopyButtonState(button, "copying");
    try {
      await this.copyText(code);
      button.dataset.state = "success";
      this.renderCopyButtonState(button, "success");
    } catch (error) {
      button.dataset.state = "error";
      this.renderCopyButtonState(button, "error");
      console.warn("[Mentor Code Webview] code copy failed", error);
    } finally {
      window.setTimeout(() => {
        button.disabled = false;
        delete button.dataset.state;
        this.renderCopyButtonState(button, "idle");
      }, 2000);
    }
  }

  private renderCopyButtonState(
    button: HTMLButtonElement,
    state: "idle" | "copying" | "success" | "error"
  ): void {
    const presentation = {
      idle: { label: "コードをコピー", icon: "ph-copy-simple" },
      copying: { label: "コピー中", icon: "ph-copy-simple" },
      success: { label: "コピー済み", icon: "ph-check-circle" },
      error: { label: "コピー失敗", icon: "ph-x" }
    }[state];
    this.factory.clear(button);
    button.title = presentation.label;
    button.setAttribute("aria-label", presentation.label);
    button.append(this.factory.phosphorIcon(presentation.icon, "code-copy-icon", CODE_COPY_ICON_SIZE));
  }

  private async applyHighlight(preview: HTMLPreElement, code: string, sourcePath: string | undefined): Promise<void> {
    const highlighter = await this.loadHighlighter();
    const highlighted = await highlighter.highlight(code, sourcePath, this.currentTheme(highlighter));
    this.factory.clear(preview);
    preview.classList.add("shiki", `language-${this.safeClassName(highlighted.language)}`);
    preview.dataset.language = highlighted.language;
    preview.dataset.theme = highlighted.theme;
    this.appendHighlightedCode(preview, highlighted);
  }

  private async loadHighlighter(): Promise<SyntaxHighlighter> {
    syntaxHighlightModulePromise ??= import("./syntaxHighlight");
    const module = await syntaxHighlightModulePromise;
    syntaxHighlighter ??= new module.SyntaxHighlighter();
    return syntaxHighlighter;
  }

  private currentTheme(highlighter: SyntaxHighlighter): SyntaxHighlightTheme {
    const classList = document.body.classList;
    if (classList.contains("vscode-light")) {
      return highlighter.themeForColorScheme("light");
    }
    if (classList.contains("vscode-high-contrast") || classList.contains("vscode-high-contrast-light")) {
      return highlighter.themeForColorScheme("high-contrast");
    }
    return highlighter.themeForColorScheme("dark");
  }

  private appendHighlightedCode(container: HTMLElement, highlighted: HighlightedCode): void {
    highlighted.lines.forEach((line, index) => {
      for (const token of line) {
        container.append(this.renderToken(token));
      }
      if (index < highlighted.lines.length - 1) {
        container.append(document.createTextNode("\n"));
      }
    });
  }

  private renderToken(token: HighlightedToken): Text | HTMLSpanElement {
    if (!token.color && !token.fontStyle) {
      return document.createTextNode(token.content);
    }

    const span = document.createElement("span");
    span.textContent = token.content;
    span.className = this.tokenClassName(token);
    return span;
  }

  private tokenClassName(token: HighlightedToken): string {
    const classNames = ["shiki-token"];
    if (token.color) {
      classNames.push(`shiki-fg-${this.colorClassSuffix(token.color)}`);
    }
    if (token.fontStyle) {
      classNames.push(...this.fontStyleClassNames(token.fontStyle));
    }

    return classNames.join(" ");
  }

  private colorClassSuffix(color: string): string {
    return color.toLowerCase().replace(/[^a-f0-9]/g, "");
  }

  private fontStyleClassNames(fontStyle: number): string[] {
    const classNames: string[] = [];
    if ((fontStyle & 1) !== 0) {
      classNames.push("shiki-token-italic");
    }
    if ((fontStyle & 2) !== 0) {
      classNames.push("shiki-token-bold");
    }
    if ((fontStyle & 4) !== 0) {
      classNames.push("shiki-token-underline");
    }
    if ((fontStyle & 8) !== 0) {
      classNames.push("shiki-token-strikethrough");
    }
    return classNames;
  }

  private markHighlightFailed(preview: HTMLPreElement, error: unknown): void {
    preview.classList.add("highlight-failed");
    preview.dataset.highlightError = error instanceof Error ? error.message : String(error);
    console.warn("[Mentor Code Webview] code preview highlight failed", error);
  }

  private safeClassName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "plaintext";
  }
}

export class PreviewView {
  private readonly codePreview: CodePreviewRenderer;
  private readonly linkedText: WorkspaceFileTextRenderer;

  public constructor(
    private readonly factory: ElementFactory,
    openWorkspaceFile: OpenWorkspaceFileHandler
  ) {
    this.codePreview = new CodePreviewRenderer(factory);
    this.linkedText = new WorkspaceFileTextRenderer(factory, openWorkspaceFile);
  }

  public render(contextPackage: ContextPackage, workspaceMap: WorkspaceMap | undefined): HTMLElement {
    const container = this.factory.element("div", "preview-block");
    const heading = this.factory.element("div", "message-heading", "送信前プレビュー");
    container.append(heading);

    if (workspaceMap) {
      container.append(this.factory.element(
        "div",
        "preview-summary",
        `送信候補 ${workspaceMap.includedFiles} 件 / 除外 ${workspaceMap.excludedFiles} 件 / 主要言語 ${workspaceMap.languageHints.join(", ") || "未判定"}`
      ));
    }

    if (contextPackage.projectReview) {
      container.append(this.renderProjectReview(contextPackage));
    }

    const flaggedFiles = this.flaggedFiles(contextPackage);
    if (flaggedFiles.length === 0) {
      const notice = this.factory.element("div", "notice-inline");
      notice.append(this.linkedText.renderInline("送信前プレビュー対象の検出ファイルはありません。マスク済みContextPackageのみ送信します。"));
      container.append(notice);
      return container;
    }

    for (const file of flaggedFiles.slice(0, 8)) {
      const section = this.factory.element("section", "preview-file");
      section.append(this.linkedText.render("div", "preview-file-title", file.path));

      if (file.reason) {
        section.append(this.linkedText.render("div", "preview-file-reason", file.reason));
      }

      if (file.review) {
        section.append(this.renderLocalLlmReview(file.review));
      }

      if (file.maskedContent) {
        const preview = this.codePreview.render(file.maskedContent.slice(0, 2400), {
          sourcePath: file.path
        });
        section.append(preview);
      }

      container.append(section);
    }

    return container;
  }

  private renderProjectReview(contextPackage: ContextPackage): HTMLElement {
    const review = contextPackage.projectReview;
    const section = this.factory.element("section", "preview-section");
    section.append(this.factory.element("div", "preview-section-title", "AIによるセキュリティレビュー"));

    if (!review) {
      return section;
    }

    const statusLabel = review.status === "completed"
      ? "実行済み"
      : review.status === "failed"
        ? "失敗"
        : "未実行";
    const summary = this.factory.element("div", review.status === "failed" ? "notice-inline notice-danger" : "notice-inline");
    summary.append(
      this.factory.element("strong", "", `AIによるセキュリティレビュー / ${statusLabel}`),
      this.factory.element("span", "", `対象 ${review.targetFiles} 件 / 送信候補 ${review.includedFiles} 件 / 除外 ${review.blockedFiles} 件`)
    );

    if (review.failureReason) {
      summary.append(this.linkedText.renderInline("失敗理由: AIによる確認を完了できませんでした。再検査してください。"));
    }

    const markdown = this.codePreview.render(review.reviewMarkdown, {
      sourcePath: "project-review.md"
    });
    section.append(summary, markdown);
    return section;
  }

  private renderLocalLlmReview(review: LocalLlmReview): HTMLElement {
    const block = this.factory.element("div", "local-review");
    const statusLabel = review.status === "completed"
      ? "実行済み"
      : review.status === "failed"
        ? "失敗"
        : "未実行";
    block.append(
      this.factory.element("div", "local-review-title", `AIによるセキュリティ確認 / ${statusLabel}`),
      this.factory.element("div", "", `検出種別: ${review.detectedTypes.join(", ") || "追加検出なし"}`),
      this.factory.element("div", "", `評価: ${review.educationSummary}`),
      this.factory.element("div", "", `推奨: ${review.recommendedAction}`)
    );

    if (review.failureReason) {
      block.append(this.factory.element("div", "", "失敗理由: AIによる確認を完了できませんでした。再検査してください。"));
    }

    return block;
  }

  private flaggedFiles(contextPackage: ContextPackage): {
    readonly path: string;
    readonly reason?: string;
    readonly maskedContent?: string;
    readonly review?: LocalLlmReview;
  }[] {
    const files = contextPackage.files
      .filter((file) => file.localLlmReview || /__[A-Z0-9_]+_\d+__/.test(file.maskedContent))
      .map((file) => ({
        path: file.path,
        maskedContent: file.maskedContent,
        ...(file.localLlmReview ? { review: file.localLlmReview } : {})
      }));
    const blockedFiles = contextPackage.blockedFiles.map((file) => ({
      path: file.path,
      reason: file.reason,
      ...(file.localLlmReview ? { review: file.localLlmReview } : {})
    }));

    return [
      ...files,
      ...blockedFiles
    ];
  }
}

export class MentorResponseView {
  private readonly codePreview: CodePreviewRenderer;
  private readonly linkedText: WorkspaceFileTextRenderer;

  public constructor(
    private readonly factory: ElementFactory,
    openWorkspaceFile: OpenWorkspaceFileHandler,
    copyText: CopyTextHandler
  ) {
    this.codePreview = new CodePreviewRenderer(factory, copyText);
    this.linkedText = new WorkspaceFileTextRenderer(factory, openWorkspaceFile);
  }

  public render(
    response: MentorResponse,
    options: { readonly showImplementationActions?: boolean } = {}
  ): HTMLElement {
    const container = this.factory.element("div", "mentor-response");
    container.append(this.linkedText.render("div", "message-heading", response.title));

    if (response.policyWarnings.length > 0) {
      const warning = this.factory.element("div", "notice-inline notice-warning");
      warning.append(this.linkedText.renderInline(response.policyWarnings.join(" ")));
      container.append(warning);
    }

    for (const section of response.sections) {
      const block = this.factory.element("section", "response-section");
      block.append(this.linkedText.render("div", "response-heading", section.heading));
      const list = this.factory.element("ul", "response-list");
      for (const item of section.items) {
        list.append(this.linkedText.render("li", "", item));
      }
      block.append(list);
      container.append(block);
    }

    const patch = patchToolCall(response);
    if (patch && options.showImplementationActions) {
      container.append(this.renderPatchPreview(patchToolCallToEditPreview(patch)));
    }

    return container;
  }

  private renderPatchPreview(proposal: MentorPatchPreview): HTMLElement {
    const block = this.factory.element("section", "response-section edit-proposal");
    block.append(this.factory.element("div", "response-heading", "編集案"));
    const summary = this.factory.element("div", "notice-inline");
    summary.append(this.linkedText.renderInline(proposal.intent));
    block.append(summary);

    for (const operation of proposal.operations) {
      const item = this.factory.element("section", "preview-file");
      item.append(
        this.linkedText.render("div", "preview-file-title", this.operationTitle(operation)),
        this.renderOperationExplanation(operation)
      );

      this.appendOperationPreview(item, operation);
      block.append(item);
    }

    return block;
  }

  private renderOperationExplanation(operation: MentorWorkspaceOperation): HTMLElement {
    const explanation = this.factory.element("div", "preview-file-explanation");
    explanation.append(
      this.factory.element("div", "preview-section-title", "変更理由・目的・影響"),
      this.linkedText.render("div", "preview-file-reason", operation.explanation)
    );
    return explanation;
  }

  private appendOperationPreview(container: HTMLElement, operation: MentorWorkspaceOperation): void {
    if (operation.type === "createFile") {
      const preview = this.codePreview.render(operation.content.slice(0, 2400), {
        className: "edit-preview-after",
        sourcePath: operation.path
      });
      container.append(this.factory.element("div", "preview-section-title", "作成内容"), preview);
      return;
    }

    if (operation.type === "replaceInFile") {
      const before = this.codePreview.render(operation.originalText.slice(0, 2400), {
        className: "edit-preview-before",
        sourcePath: operation.path
      });
      const after = this.codePreview.render(operation.replacementText.slice(0, 2400), {
        className: "edit-preview-after",
        sourcePath: operation.path
      });
      container.append(
        this.factory.element("div", "preview-section-title", "置換前"),
        before,
        this.factory.element("div", "preview-section-title", "置換後"),
        after
      );
    }
  }

  private operationTitle(operation: MentorWorkspaceOperation): string {
    switch (operation.type) {
      case "createFile":
        return `ファイル作成: ${operation.path}`;
      case "createDirectory":
        return `ディレクトリ作成: ${operation.path}`;
      case "replaceInFile":
        return `ファイル編集: ${operation.path}`;
      case "renamePath":
        return `リネーム: ${operation.path} -> ${operation.newPath}`;
      case "deletePath":
        return `削除: ${operation.path}${operation.recursive ? "（再帰）" : ""}`;
      default:
        return "";
    }
  }

  private list(title: string, items: readonly string[]): HTMLElement {
    const section = this.factory.element("section", "response-section");
    section.append(this.linkedText.render("div", "response-heading", title));
    const list = this.factory.element("ul", "response-list");
    for (const item of items) {
      list.append(this.linkedText.render("li", "", item));
    }
    section.append(list);
    return section;
  }
}

export class CommandCardView {
  private readonly codePreview: CodePreviewRenderer;
  private readonly linkedText: WorkspaceFileTextRenderer;

  public constructor(
    private readonly factory: ElementFactory,
    openWorkspaceFile: OpenWorkspaceFileHandler,
    copyText: CopyTextHandler
  ) {
    this.codePreview = new CodePreviewRenderer(factory, copyText);
    this.linkedText = new WorkspaceFileTextRenderer(factory, openWorkspaceFile);
  }

  public render(card: CommandApprovalCard): HTMLElement {
    const container = this.factory.element("div", "command-card");
    container.append(this.factory.element("div", "message-heading", "コマンド承認カード"));
    const workingDirectory = this.factory.element("div", "notice-inline");
    workingDirectory.append(this.linkedText.renderInline(`作業ディレクトリ: ${card.workingDirectory}`));
    const risk = this.factory.element("div", "notice-inline");
    risk.append(this.linkedText.renderInline(`危険度: ${card.risk.toUpperCase()} / ${card.allowedToExecute ? "承認後実行可" : "コピー提示のみ"}`));
    container.append(workingDirectory, risk);
    if (card.shell) {
      const shell = this.factory.element("div", "notice-inline");
      shell.append(this.linkedText.renderInline(`シェル: ${card.shell}`));
      container.append(shell);
    }
    container.append(this.list("意味", [card.meaning]));
    container.append(this.list("期待結果", [card.expectedResult]));
    container.append(this.list("危険性", card.hazards));
    container.append(this.list("取り消し・復旧", card.rollback));

    const preview = this.codePreview.render(card.command, {
      sourcePath: this.commandSourcePath(card.shell)
    });
    container.append(preview);
    return container;
  }

  private commandSourcePath(shell: string | undefined): string {
    if (shell === "powershell" || shell === "pwsh") {
      return "command.ps1";
    }
    if (shell === "cmd") {
      return "command.cmd";
    }
    return "command.sh";
  }

  private list(title: string, items: readonly string[]): HTMLElement {
    const section = this.factory.element("section", "response-section");
    section.append(this.linkedText.render("div", "response-heading", title));
    const list = this.factory.element("ul", "response-list");
    for (const item of items) {
      list.append(this.linkedText.render("li", "", item));
    }
    section.append(list);
    return section;
  }
}

export class McpToolCardView {
  private readonly codePreview: CodePreviewRenderer;

  public constructor(
    private readonly factory: ElementFactory,
    copyText: CopyTextHandler
  ) {
    this.codePreview = new CodePreviewRenderer(factory, copyText);
  }

  public render(toolCall: MentorMcpToolCall): HTMLElement {
    const container = this.factory.element("div", "command-card mcp-tool-card");
    container.append(this.factory.element("div", "message-heading", "MCP Tool承認カード"));
    container.append(
      this.factory.element("div", "notice-inline", `サーバー: ${toolCall.serverId}`),
      this.factory.element("div", "notice-inline", `Tool: ${toolCall.toolName}`),
      this.factory.element("div", "notice-inline", "危険度: HIGH / 承認後実行可")
    );
    container.append(this.list("目的", [toolCall.intent]));
    container.append(this.list("期待結果", [toolCall.expectedResult]));
    container.append(this.list("危険性", [
      "Toolの注釈は信頼せず、外部サービス上の読み取り・書き込み・削除が起こり得るものとして扱います。",
      "実行結果はPrivacy Guardを通過したテキストだけが会話へ戻されます。"
    ]));
    container.append(this.list("取り消し・復旧", [
      "外部変更の自動ロールバックはありません。実行前に引数と対象を確認してください。"
    ]));
    container.append(this.codePreview.render(JSON.stringify(toolCall.arguments, null, 2), {
      sourcePath: "mcp-arguments.json"
    }));
    return container;
  }

  private list(title: string, items: readonly string[]): HTMLElement {
    const section = this.factory.element("section", "response-section");
    section.append(this.factory.element("div", "response-heading", title));
    const list = this.factory.element("ul", "response-list");
    for (const item of items) {
      list.append(this.factory.element("li", "", item));
    }
    section.append(list);
    return section;
  }
}
