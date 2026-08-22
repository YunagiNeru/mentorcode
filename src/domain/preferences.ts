export const SEND_SHORTCUT_VALUES = [
  "ctrlEnter",
  "enter"
] as const;

export type SendShortcut = typeof SEND_SHORTCUT_VALUES[number];

export const DEFAULT_SEND_SHORTCUT: SendShortcut = "ctrlEnter";
export const DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED = true;
export const DEFAULT_ACTIVITY_BADGE_ENABLED = true;
export const DEFAULT_CUSTOM_INSTRUCTIONS_ENABLED = true;

export interface AppSettings {
  readonly sendShortcut: SendShortcut;
  readonly desktopNotificationsEnabled: boolean;
  readonly activityBadgeEnabled: boolean;
  readonly customInstructionsEnabled: boolean;
  readonly serverTokenConfigured: boolean;
  readonly serverToken: string;
}

export interface ComposerKeyDownInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
  readonly sendShortcut: SendShortcut;
}

export function normalizeSendShortcut(value: unknown): SendShortcut {
  return value === "enter" ? "enter" : DEFAULT_SEND_SHORTCUT;
}

export function normalizeBooleanPreference(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

export function shouldSubmitComposerOnKeyDown(input: ComposerKeyDownInput): boolean {
  if (input.key !== "Enter" || input.shiftKey || input.altKey || input.metaKey || input.isComposing) {
    return false;
  }

  if (input.sendShortcut === "enter") {
    return true;
  }

  return input.ctrlKey;
}
