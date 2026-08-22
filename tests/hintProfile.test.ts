import { describe, expect, it } from "vitest";
import { HintProfileResolver } from "../src/domain/mentor/hintProfile";

describe("HintProfileResolver", () => {
  it("keeps implementation action gates without reducing the teacher's understanding duty", () => {
    const resolver = new HintProfileResolver();

    expect(resolver.resolve("low")).toMatchObject({
      allowsImplementationActions: false
    });
    expect(resolver.resolve("low").guidance.join("\n")).toContain("必要な資料と現状を先に把握");
    expect(resolver.resolve("low").guidance.join("\n")).not.toContain("ユーザーが自分で調べる");
    expect(resolver.resolve("medium")).toMatchObject({
      allowsImplementationActions: false
    });
    expect(resolver.resolve("high")).toMatchObject({
      allowsImplementationActions: true
    });
    expect(resolver.resolve("very_high")).toMatchObject({
      allowsImplementationActions: true
    });
  });

  it("keeps legacy numeric levels compatible with the four current stages", () => {
    const resolver = new HintProfileResolver();

    expect(resolver.resolve(0).level).toBe("low");
    expect(resolver.resolve(2).level).toBe("medium");
    expect(resolver.resolve(4).level).toBe("high");
    expect(resolver.resolve(5).level).toBe("very_high");
  });
});
