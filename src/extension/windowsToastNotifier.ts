import { join } from "node:path";

export interface WindowsToastNotification {
  readonly title: string;
  readonly message: string;
  readonly onClick?: () => void | Promise<void>;
}

interface NodeNotifierModule {
  readonly WindowsToaster?: new (options?: {
    readonly withFallback?: boolean;
  }) => ToastNotifier;
}

interface ToastNotifier {
  notify(
    notification: {
      readonly title: string;
      readonly message: string;
      readonly icon: string;
      readonly appID: string;
      readonly sound: boolean;
    },
    callback?: (error: Error | null, response: unknown, metadata?: unknown) => void
  ): void;
}

const clickResponseTokens = new Set([
  "activate",
  "activated",
  "buttonclicked",
  "click",
  "clicked"
]);

export function isWindowsToastClickResponse(response: unknown, metadata?: unknown): boolean {
  return hasToastClickToken(response) || hasToastClickToken(metadata);
}

function hasToastClickToken(value: unknown): boolean {
  const token = normalizeToastResponseToken(value);
  if (token) {
    return clickResponseTokens.has(token);
  }

  if (!isRecord(value)) {
    return false;
  }

  return ["activationType", "action", "response", "type"].some((key) => {
    const fieldToken = normalizeToastResponseToken(value[key]);
    return fieldToken ? clickResponseTokens.has(fieldToken) : false;
  });
}

function normalizeToastResponseToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const token = value.toLowerCase().trim().replace(/[^a-z]/g, "");
  return token.length > 0 ? token : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class WindowsToastNotifier {
  private readonly iconPath: string;
  private toaster: ToastNotifier | undefined;
  private toasterLoadFailed = false;

  public constructor(extensionRoot: string) {
    this.iconPath = join(extensionRoot, "media", "mentorcode_logo_mark.png");
  }

  public notify(notification: WindowsToastNotification): void {
    if (process.platform !== "win32") {
      return;
    }

    const toaster = this.resolveToaster();
    if (!toaster) {
      return;
    }

    toaster.notify({
      title: notification.title,
      message: notification.message,
      icon: this.iconPath,
      appID: "Mentor Code",
      sound: true
    }, (error, response, metadata) => {
      if (error) {
        console.error("[Mentor Code Extension] Windows toast notification failed", error);
        return;
      }

      if (isWindowsToastClickResponse(response, metadata) && notification.onClick) {
        void notification.onClick();
      }
    });
  }

  private resolveToaster(): ToastNotifier | undefined {
    if (this.toaster || this.toasterLoadFailed) {
      return this.toaster;
    }

    try {
      const notifier = require("node-notifier") as NodeNotifierModule;
      const WindowsToaster = notifier.WindowsToaster;
      if (!WindowsToaster) {
        throw new Error("node-notifier WindowsToaster export is unavailable.");
      }

      this.toaster = new WindowsToaster({
        withFallback: false
      });
      return this.toaster;
    } catch (error) {
      this.toasterLoadFailed = true;
      console.error("[Mentor Code Extension] Windows toast notification module is unavailable", error);
      return undefined;
    }
  }
}
