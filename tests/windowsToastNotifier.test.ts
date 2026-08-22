import { describe, expect, it } from "vitest";
import { isWindowsToastClickResponse } from "../src/extension/windowsToastNotifier";

describe("isWindowsToastClickResponse", () => {
  it("accepts Windows toaster click response strings", () => {
    expect(isWindowsToastClickResponse("click")).toBe(true);
    expect(isWindowsToastClickResponse("activate")).toBe(true);
    expect(isWindowsToastClickResponse("clicked")).toBe(true);
    expect(isWindowsToastClickResponse(" ButtonClicked ")).toBe(true);
  });

  it("accepts click response fields from toaster metadata objects", () => {
    expect(isWindowsToastClickResponse({ activationType: "activate" })).toBe(true);
    expect(isWindowsToastClickResponse({ action: "buttonClicked" })).toBe(true);
    expect(isWindowsToastClickResponse("activate", { activationType: "activate" })).toBe(true);
  });

  it("rejects non-click toaster responses", () => {
    expect(isWindowsToastClickResponse("timeout")).toBe(false);
    expect(isWindowsToastClickResponse("dismissed")).toBe(false);
    expect(isWindowsToastClickResponse({ activationType: "timedOut" })).toBe(false);
    expect(isWindowsToastClickResponse({ action: "dismissed" })).toBe(false);
    expect(isWindowsToastClickResponse(undefined)).toBe(false);
  });
});
