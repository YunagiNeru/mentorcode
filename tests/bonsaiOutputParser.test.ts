import { describe, expect, it } from "vitest";
import { BonsaiOutputParser } from "../src/localLlm/bonsaiOutputParser";

describe("BonsaiOutputParser", () => {
  it("uses the last valid Bonsai classification when llama.cpp echoes prompts and stats", () => {
    const output = [
      "Loading model...",
      "Schema: {\"verdict\":\"safe|credential_likely|private_internal|customer_or_personal_data|business_confidential_context\",\"confidence\":0.0}",
      "Mechanical detections:",
      "[{\"type\":\"GOOGLE_API_KEY\",\"severity\":\"high\",\"action\":\"mask\",\"placeholder\":\"__GOOGLE_API_KEY_1__\"}]",
      "{",
      "  \"verdict\": \"safe\",",
      "  \"confidence\": 0.42,",
      "  \"educationSummary\": \"AIによるセキュリティ確認ではマスク済みの認証情報候補を確認しました。\",",
      "  \"riskPoints\": [\"APIキーは漏洩すると第三者利用につながります。\"],",
      "  \"recommendedAction\": \"実値を再発行し、環境変数へ移してください。\"",
      "}",
      "[ Prompt: 223.0 t/s | Generation: 60.0 t/s ]"
    ].join("\r\n");

    const parsed = new BonsaiOutputParser().parse(output);

    expect(parsed.verdict).toBe("safe");
    expect(parsed.confidence).toBe(0.42);
    expect(parsed.riskPoints).toEqual([
      "APIキーは漏洩すると第三者利用につながります。"
    ]);
  });

  it("ignores braces inside JSON strings", () => {
    const parsed = new BonsaiOutputParser().parse([
      "{",
      "  \"verdict\": \"private_internal\",",
      "  \"confidence\": 0.8,",
      "  \"educationSummary\": \"説明内の {placeholder} は本文ではありません。\",",
      "  \"riskPoints\": [],",
      "  \"recommendedAction\": \"マスク済みプレビューだけを共有してください。\"",
      "}"
    ].join("\n"));

    expect(parsed.verdict).toBe("private_internal");
    expect(parsed.confidence).toBe(0.8);
    expect(parsed.educationSummary).toContain("{placeholder}");
  });

  it("normalizes loose confidence and risk point shapes from Bonsai", () => {
    const parsed = new BonsaiOutputParser().parse(JSON.stringify({
      verdict: "credential_likely",
      confidence: "high",
      educationSummary: "マスク済みの認証情報候補があります。",
      riskPoints: [
        {
          point: "high",
          description: "認証情報が含まれていた証跡があります。"
        }
      ],
      recommendedAction: "実値は復元せず、安全な保管場所へ移してください。"
    }));

    expect(parsed.confidence).toBe(0.9);
    expect(parsed.riskPoints).toEqual([
      "認証情報が含まれていた証跡があります。"
    ]);
  });

  it("fails when no valid classification JSON exists", () => {
    expect(() => new BonsaiOutputParser().parse("Loading model...\n{\"type\":\"GOOGLE_API_KEY\"}")).toThrow(
      "Bonsai local LLM did not return a valid classification JSON."
    );
  });
});
