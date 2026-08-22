import { describe, expect, it } from "vitest";
import {
  lineNumberCustomInstruction,
  splitCustomInstructionLines
} from "../src/domain/customInstructionLines";

describe("custom instruction line contract", () => {
  it.each([
    ["", [""]],
    ["first", ["first"]],
    ["first\nsecond", ["first", "second"]],
    ["first\r\nsecond", ["first", "second"]],
    ["first\n", ["first", ""]],
    ["first\n\nthird", ["first", "", "third"]]
  ])("splits logical lines without losing blank lines", (content, expected) => {
    expect(splitCustomInstructionLines(content)).toEqual(expected);
  });

  it("uses the same one-based references returned by reviews", () => {
    expect(lineNumberCustomInstruction("first\n\nthird")).toBe(
      "L1: first\nL2: \nL3: third"
    );
  });
});
