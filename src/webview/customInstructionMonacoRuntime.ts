import "monaco-editor/min/vs/editor/editor.main.css";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker&inline";

export interface CustomInstructionMonacoRuntimeOptions {
  readonly host: HTMLElement;
  readonly initialValue: string;
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly metricsSource: HTMLTextAreaElement;
  readonly onInput: (value: string) => void;
  readonly onBlur: () => void;
  readonly readClipboardText: () => Promise<string>;
  readonly onFailure: (failureCode: string) => void;
}

interface MonacoEnvironmentHost extends Window {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, _label: string) => Worker;
  };
}

const THEME_NAME = "mentor-code-custom-instruction";

export class CustomInstructionMonacoRuntime {
  private readonly container: HTMLDivElement;
  private readonly model: monaco.editor.ITextModel;
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly disposables: monaco.IDisposable[] = [];
  private readonly themeObserver: MutationObserver;
  private settingValue = false;
  private disposed = false;
  private failed = false;

  public constructor(private readonly options: CustomInstructionMonacoRuntimeOptions) {
    this.installWorkerEnvironment();
    this.container = document.createElement("div");
    this.container.className = "custom-instruction-monaco-surface";
    this.options.host.append(this.container);

    const uri = monaco.Uri.parse("inmemory://custom-instructions/AGENTS.md");
    this.model = monaco.editor.createModel(options.initialValue, "markdown", uri);
    this.model.setEOL(this.preferredEndOfLine(options.initialValue));
    this.defineTheme();

    const metrics = getComputedStyle(options.metricsSource);
    this.editor = monaco.editor.create(this.container, {
      model: this.model,
      theme: THEME_NAME,
      ariaLabel: options.ariaLabel,
      placeholder: options.placeholder,
      automaticLayout: true,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: this.pixelValue(metrics.paddingLeft) / 2,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      wrappingIndent: "same",
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: true,
      renderWhitespace: "selection",
      contextmenu: true,
      links: false,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      acceptSuggestionOnEnter: "off",
      parameterHints: { enabled: false },
      hover: { enabled: false },
      codeLens: false,
      occurrencesHighlight: "off",
      selectionHighlight: false,
      stickyScroll: { enabled: false },
      fontFamily: metrics.fontFamily,
      fontSize: this.pixelValue(metrics.fontSize),
      lineHeight: this.pixelValue(metrics.lineHeight),
      padding: {
        top: this.pixelValue(metrics.paddingTop),
        bottom: this.pixelValue(metrics.paddingBottom)
      }
    });
    this.registerClipboardKeybindings();

    this.disposables.push(
      this.editor.onDidChangeModelContent(() => {
        if (!this.settingValue) {
          this.options.onInput(this.model.getValue());
        }
      }),
      this.editor.onDidBlurEditorText(() => this.options.onBlur())
    );

    this.themeObserver = new MutationObserver(() => this.defineTheme());
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style"]
    });
  }

  public get value(): string {
    return this.model.getValue();
  }

  public setValue(value: string): void {
    if (this.model.getValue() === value) {
      return;
    }
    this.settingValue = true;
    try {
      this.model.setValue(value);
      this.model.setEOL(this.preferredEndOfLine(value));
    } finally {
      this.settingValue = false;
    }
  }

  public focus(): void {
    this.editor.focus();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.themeObserver.disconnect();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.editor.dispose();
    this.model.dispose();
    this.container.remove();
  }

  private registerClipboardKeybindings(): void {
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC,
      () => this.editor.trigger("keyboard", "editor.action.clipboardCopyAction", null)
    );
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV,
      () => void this.pasteClipboardText()
    );
  }

  private async pasteClipboardText(): Promise<void> {
    const text = await this.options.readClipboardText();
    const selections = this.editor.getSelections();
    if (this.disposed || !selections?.length || text.length === 0) {
      return;
    }

    this.editor.pushUndoStop();
    this.editor.executeEdits(
      "clipboard",
      selections.map((range) => ({ range, text, forceMoveMarkers: true }))
    );
    this.editor.pushUndoStop();
  }

  private installWorkerEnvironment(): void {
    const host = window as MonacoEnvironmentHost;
    host.MonacoEnvironment = {
      getWorker: () => {
        const worker = new EditorWorker();
        worker.addEventListener("error", () => this.reportFailure("worker_error"), { once: true });
        return worker;
      }
    };
  }

  private reportFailure(failureCode: string): void {
    if (this.failed || this.disposed) {
      return;
    }
    this.failed = true;
    this.options.onFailure(failureCode);
  }

  private defineTheme(): void {
    const bodyClasses = document.body.classList;
    const base = bodyClasses.contains("vscode-high-contrast-light")
      ? "hc-light"
      : bodyClasses.contains("vscode-light")
        ? "vs"
        : bodyClasses.contains("vscode-high-contrast")
          ? "hc-black"
          : "vs-dark";

    monaco.editor.defineTheme(THEME_NAME, {
      base,
      inherit: true,
      rules: [],
      colors: {
        "editor.background": this.themeColor("background"),
        "editor.foreground": this.themeColor("foreground"),
        "editorGutter.background": this.themeColor("gutter"),
        "editorLineNumber.foreground": this.themeColor("line-number"),
        "editorLineNumber.activeForeground": this.themeColor("line-number-active"),
        "editor.lineHighlightBackground": this.themeColor("line-highlight"),
        "editorCursor.foreground": this.themeColor("cursor"),
        "editor.selectionBackground": this.themeColor("selection"),
        "editor.inactiveSelectionBackground": this.themeColor("selection-inactive")
      }
    });
    monaco.editor.setTheme(THEME_NAME);
  }

  private themeColor(name: string): string {
    const probe = document.createElement("span");
    probe.className = `custom-instruction-theme-probe custom-instruction-theme-probe-${name}`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return this.toHexColor(color);
  }

  private toHexColor(color: string): string {
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3) {
      throw new Error("Invalid editor theme color.");
    }
    const red = values[0] ?? 0;
    const green = values[1] ?? 0;
    const blue = values[2] ?? 0;
    const alpha = values[3] ?? 1;
    const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
    const opacity = alpha < 1 ? channel(alpha * 255) : "";
    return `#${channel(red)}${channel(green)}${channel(blue)}${opacity}`;
  }

  private preferredEndOfLine(value: string): monaco.editor.EndOfLineSequence {
    const crlfCount = value.match(/\r\n/g)?.length ?? 0;
    const lfCount = value.match(/(?<!\r)\n/g)?.length ?? 0;
    return crlfCount > lfCount
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF;
  }

  private pixelValue(value: string): number {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
      throw new Error("Invalid editor metric.");
    }
    return parsed;
  }
}
