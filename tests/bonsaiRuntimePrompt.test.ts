import { describe, expect, it } from "vitest";
import { BonsaiRuntime } from "../src/localLlm/bonsaiRuntime";

describe("BonsaiRuntime prompt", () => {
  it("treats redacted placeholders as removed values, not residual private_internal risk", () => {
    const runtime = new BonsaiRuntime({
      root: "mock"
    });
    const prompt = (runtime as unknown as {
      createPrompt(path: string, snippet: string): string;
    }).createPrompt("index.html", "<code>__INTERNAL_URL_1__</code>");

    expect(prompt).toContain("Redacted placeholders by themselves are not residual risk");
    expect(prompt).toContain("concrete unredacted internal URLs");
    expect(prompt).not.toContain("redacted internal placeholders");
  });
});
