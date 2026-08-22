import type { ElementFactory } from "./components";
import type { CustomInstructionMonacoRuntime } from "./customInstructionMonacoRuntime";

export interface CustomInstructionTextEditorOptions {
  readonly initialValue: string;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly onInput: (value: string) => void;
  readonly onBlur: () => void;
  readonly readClipboardText: () => Promise<string>;
}

export class CustomInstructionTextEditor {
  public readonly element: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly fallbackInput: HTMLTextAreaElement;
  private readonly status: HTMLParagraphElement;
  private runtime: CustomInstructionMonacoRuntime | undefined;
  private currentValue: string;
  private disposed = false;
  private fallbackActive = true;

  public constructor(
    private readonly factory: ElementFactory,
    private readonly options: CustomInstructionTextEditorOptions
  ) {
    this.currentValue = options.initialValue;
    this.element = this.factory.element("div", "custom-instruction-editor");
    this.frame = this.factory.element("div", "custom-instruction-editor-frame");
    this.frame.dataset.editorStatus = "loading";
    this.fallbackInput = this.createFallbackInput();
    this.status = this.factory.element(
      "p",
      "custom-instruction-editor-runtime-status",
      "VS Codeエディタを読み込んでいます"
    );
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.frame.append(this.fallbackInput);
    this.element.append(this.frame, this.status);
    void this.initializeMonaco();
  }

  public get value(): string {
    return this.runtime?.value ?? this.currentValue;
  }

  public setValue(value: string): void {
    this.currentValue = value;
    this.fallbackInput.value = value;
    this.runtime?.setValue(value);
  }

  public focus(): void {
    if (this.runtime) {
      this.runtime.focus();
      return;
    }
    this.fallbackInput.focus();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.runtime?.dispose();
    this.runtime = undefined;
  }

  private createFallbackInput(): HTMLTextAreaElement {
    const input = this.factory.element(
      "textarea",
      "custom-instruction-input custom-instruction-input-fallback"
    ) as HTMLTextAreaElement;
    input.value = this.currentValue;
    input.placeholder = this.options.placeholder;
    input.spellcheck = false;
    input.setAttribute("aria-label", this.options.ariaLabel);
    input.addEventListener("input", () => {
      if (!this.fallbackActive) {
        return;
      }
      this.currentValue = input.value;
      this.options.onInput(this.currentValue);
    });
    input.addEventListener("blur", () => {
      if (this.fallbackActive) {
        this.options.onBlur();
      }
    });
    return input;
  }

  private async initializeMonaco(): Promise<void> {
    try {
      const { CustomInstructionMonacoRuntime } = await import("./customInstructionMonacoRuntime");
      if (this.disposed) {
        return;
      }
      const runtime = new CustomInstructionMonacoRuntime({
        host: this.frame,
        initialValue: this.currentValue,
        ariaLabel: this.options.ariaLabel,
        placeholder: this.options.placeholder,
        metricsSource: this.fallbackInput,
        onInput: (value) => {
          this.currentValue = value;
          this.options.onInput(value);
        },
        onBlur: this.options.onBlur,
        readClipboardText: this.options.readClipboardText,
        onFailure: (failureCode) => this.activateFallback(failureCode)
      });
      if (this.disposed) {
        runtime.dispose();
        return;
      }
      this.runtime = runtime;
      this.fallbackActive = false;
      this.fallbackInput.remove();
      this.frame.dataset.editorStatus = "ready";
      this.status.hidden = true;
      this.status.textContent = "";
    } catch (error: unknown) {
      this.activateFallback(this.safeFailureCode(error));
    }
  }

  private activateFallback(failureCode: string): void {
    if (this.disposed || (this.fallbackActive && this.frame.dataset.editorStatus === "fallback")) {
      return;
    }
    if (this.runtime) {
      this.currentValue = this.runtime.value;
      this.runtime.dispose();
      this.runtime = undefined;
    }
    this.fallbackInput.value = this.currentValue;
    if (!this.fallbackInput.isConnected) {
      this.frame.append(this.fallbackInput);
    }
    this.fallbackActive = true;
    this.frame.dataset.editorStatus = "fallback";
    this.status.hidden = false;
    this.status.textContent = "VS Codeエディタを読み込めなかったため、標準編集モードで表示しています。";
    console.error(`[custom-instruction-editor] Monaco fallback activated: ${failureCode}`);
  }

  private safeFailureCode(error: unknown): string {
    return error instanceof Error && error.name ? error.name : "unknown_error";
  }
}
