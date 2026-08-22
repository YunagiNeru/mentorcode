import { describe, expect, it } from "vitest";
import {
  GeminiContractProbe,
  GeminiContractProbeConfigurationError,
  loadGeminiContractProbeConfig
} from "../src/server/ops/geminiContractProbe";

describe("GeminiContractProbe", () => {
  it("fails closed unless live provider use is explicitly authorized", () => {
    expect(() => loadGeminiContractProbeConfig({
      GEMINI_API_KEY: "secret-key",
      GEMINI_MODEL: "test-model"
    })).toThrowError(expect.objectContaining({
      code: "live_probe_not_authorized"
    } satisfies Partial<GeminiContractProbeConfigurationError>));
  });

  it("requires the key and model without returning their values in configuration errors", () => {
    expect(() => loadGeminiContractProbeConfig({
      MENTOR_ALLOW_LIVE_GEMINI_CANARY: "true"
    })).toThrowError(expect.objectContaining({ code: "api_key_missing" }));
    expect(() => loadGeminiContractProbeConfig({
      MENTOR_ALLOW_LIVE_GEMINI_CANARY: "true",
      GEMINI_API_KEY: "secret-key"
    })).toThrowError(expect.objectContaining({ code: "model_missing" }));
  });

  it("never copies provider exception messages or API keys into probe results", async () => {
    const secret = "secret-key-that-must-not-appear";
    const probe = new GeminiContractProbe(() => ({
      createMentorResponse: () => Promise.reject(new Error(`provider failed with ${secret}`))
    }));

    const result = await probe.run({ apiKey: secret, model: "test-model" });

    expect(result).toMatchObject({
      ok: false,
      failureKind: "validation_or_contract"
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("provider failed");
  });

  it("reports only structural success metadata, not generated response text", async () => {
    const probe = new GeminiContractProbe(() => ({
      createMentorResponse: () => Promise.resolve({
        title: "generated-title-that-must-not-be-logged",
        sections: [{ heading: "result", items: ["generated-body"] }],
        policyWarnings: []
      })
    }));

    const result = await probe.run({ apiKey: "secret-key", model: "test-model" });

    expect(result).toMatchObject({
      ok: true,
      sectionCount: 1,
      hasPolicyWarnings: false
    });
    expect(JSON.stringify(result)).not.toContain("generated-title");
    expect(JSON.stringify(result)).not.toContain("generated-body");
  });
});
