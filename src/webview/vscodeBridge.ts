export interface WebviewBridgeMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface VsCodeApi {
  postMessage(message: WebviewBridgeMessage): void;
}

declare const acquireVsCodeApi: undefined | (() => VsCodeApi);

export class VscodeBridge {
  private readonly api: VsCodeApi | undefined;

  public constructor() {
    this.api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  }

  public get isVsCode(): boolean {
    return this.api !== undefined;
  }

  public post(message: WebviewBridgeMessage): void {
    this.api?.postMessage(message);
  }

  public onMessage(handler: (message: WebviewBridgeMessage) => void): void {
    window.addEventListener("message", (event: MessageEvent<WebviewBridgeMessage>) => {
      handler(event.data);
    });
  }
}
