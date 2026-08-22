import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVITY_BADGE_ENABLED,
  DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED,
  DEFAULT_SEND_SHORTCUT,
  normalizeBooleanPreference,
  normalizeSendShortcut,
  shouldSubmitComposerOnKeyDown,
  type ComposerKeyDownInput
} from "../src/domain/preferences";

function keyDown(override: Partial<ComposerKeyDownInput> = {}): ComposerKeyDownInput {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    sendShortcut: DEFAULT_SEND_SHORTCUT,
    ...override
  };
}

describe("normalizeSendShortcut", () => {
  it("keeps supported values and falls back to Ctrl+Enter", () => {
    expect(normalizeSendShortcut("enter")).toBe("enter");
    expect(normalizeSendShortcut("ctrlEnter")).toBe("ctrlEnter");
    expect(normalizeSendShortcut("unknown")).toBe(DEFAULT_SEND_SHORTCUT);
  });
});

describe("normalizeBooleanPreference", () => {
  it("keeps boolean values and falls back to the requested default", () => {
    expect(normalizeBooleanPreference(true, false)).toBe(true);
    expect(normalizeBooleanPreference(false, true)).toBe(false);
    expect(normalizeBooleanPreference("true", DEFAULT_DESKTOP_NOTIFICATIONS_ENABLED)).toBe(true);
    expect(normalizeBooleanPreference(undefined, DEFAULT_ACTIVITY_BADGE_ENABLED)).toBe(true);
    expect(normalizeBooleanPreference(null, false)).toBe(false);
  });
});

describe("shouldSubmitComposerOnKeyDown", () => {
  it("uses Ctrl+Enter as the default send shortcut", () => {
    expect(shouldSubmitComposerOnKeyDown(keyDown())).toBe(false);
    expect(shouldSubmitComposerOnKeyDown(keyDown({ ctrlKey: true }))).toBe(true);
  });

  it("uses Enter when the send shortcut is configured that way", () => {
    expect(shouldSubmitComposerOnKeyDown(keyDown({ sendShortcut: "enter" }))).toBe(true);
    expect(shouldSubmitComposerOnKeyDown(keyDown({ sendShortcut: "enter", ctrlKey: true }))).toBe(true);
  });

  it("keeps newline and IME composition paths from submitting", () => {
    expect(shouldSubmitComposerOnKeyDown(keyDown({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shouldSubmitComposerOnKeyDown(keyDown({ ctrlKey: true, isComposing: true }))).toBe(false);
    expect(shouldSubmitComposerOnKeyDown(keyDown({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});
