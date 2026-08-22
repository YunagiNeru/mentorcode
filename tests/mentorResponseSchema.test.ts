import { describe, expect, it } from "vitest";
import { MentorResponseSchema, MentorResponseSchemaError } from "../src/server/llm/mentorResponseSchema";

const patch = [
  "*** Begin Patch",
  "*** Update File: src/App.ts",
  "@@",
  "-export const value = 1;",
  "+export const value = 2;",
  "*** End Patch"
].join("\n");

describe("MentorResponseSchema", () => {
  it("normalizes manual implementation metadata for safe UI handling", () => {
    const schema = new MentorResponseSchema();
    const parsed = schema.parseStrict(JSON.stringify({
      title: "手動実装",
      sections: [],
      policyWarnings: [],
      manualImplementation: {
        required: true,
        reason: "安全検証で自動編集できません。",
        targetFiles: ["src/config.ts", "", 123]
      }
    }), "test");

    expect(parsed.manualImplementation).toEqual({
      required: true,
      reason: "安全検証で自動編集できません。",
      targetFiles: ["src/config.ts"]
    });
  });

  it("normalizes nullable or empty-object toolCalls from JSON-mode LLMs", () => {
    const schema = new MentorResponseSchema();
    const nullable = schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "方針",
          items: ["確認します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: null
    }), "Gemini");
    const emptyObject = schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "方針",
          items: ["確認します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: {}
    }), "Gemini");

    expect(nullable.toolCalls).toBeUndefined();
    expect(emptyObject.toolCalls).toBeUndefined();
    expect(emptyObject.policyWarnings).toEqual([]);
  });

  it("normalizes a single section item string into an item list", () => {
    const parsed = new MentorResponseSchema().parse(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "方針",
          items: "確認します。"
        }
      ],
      policyWarnings: null
    }), "Gemini");

    expect(parsed.sections[0]?.items).toEqual(["確認します。"]);
    expect(parsed.policyWarnings).toEqual([]);
  });

  it("normalizes fenced JSON and loose section records", () => {
    const parsed = new MentorResponseSchema().parse([
      "```json",
      JSON.stringify({
        sections: {
          方針: "プロジェクト構成を確認します。"
        },
        policyWarnings: "機密情報は送信しません。"
      }),
      "```"
    ].join("\n"), "Gemini");

    expect(parsed.title).toBe("メンター応答");
    expect(parsed.sections).toEqual([
      {
        heading: "方針",
        items: ["プロジェクト構成を確認します。"]
      }
    ]);
    expect(parsed.policyWarnings).toEqual(["機密情報は送信しません。"]);
  });

  it("normalizes run_command tool calls without dropping executable intent", () => {
    const parsed = new MentorResponseSchema().parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "次の操作",
          items: ["依存関係を確認します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: [
        {
          type: "run_command",
          shell: "PowerShell",
          command: "npm test",
          meaning: "",
          expectedResult: ""
        }
      ]
    }), "Gemini");

    expect(parsed.toolCalls).toEqual([
      {
        type: "run_command",
        shell: "powershell",
        command: "npm test",
        workingDirectory: ".",
        meaning: "LLMが提案したコマンドを実行します。",
        expectedResult: "コマンドの標準出力と標準エラーを確認します。"
      }
    ]);
  });

  it("accepts apply_patch tool calls", () => {
    const parsed = new MentorResponseSchema().parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "編集",
          items: ["パッチで更新します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: [
        {
          type: "apply_patch",
          intent: "値を更新します。",
          patch
        }
      ]
    }), "Gemini");

    expect(parsed.toolCalls?.[0]).toEqual({
      type: "apply_patch",
      intent: "値を更新します。",
      patch
    });
  });

  it("accepts MCP tool calls with object arguments", () => {
    const parsed = new MentorResponseSchema().parseStrict(JSON.stringify({
      title: "MCP提案",
      sections: [{ heading: "確認", items: ["承認後に実行します。"] }],
      policyWarnings: [],
      toolCalls: [{
        type: "mcp_tool",
        serverId: "project-tools",
        toolName: "lookup.issue",
        arguments: { issueId: "123" },
        intent: "Issueの状態を確認します。",
        expectedResult: "Issueの状態と担当者を取得します。"
      }]
    }), "OpenAI");

    expect(parsed.toolCalls?.[0]).toMatchObject({
      type: "mcp_tool",
      serverId: "project-tools",
      toolName: "lookup.issue",
      arguments: { issueId: "123" }
    });
  });

  it("normalizes per-file explanations against canonical patch paths", () => {
    const parsed = new MentorResponseSchema().parseStrictWithDiagnostics(JSON.stringify({
      title: "応答",
      sections: [{ heading: "編集", items: ["パッチで更新します。"] }],
      policyWarnings: [],
      toolCalls: [
        {
          type: "apply_patch",
          intent: "値を更新します。",
          patch,
          fileExplanations: [
            {
              path: "SRC\\APP.TS",
              explanation: "表示と保存で同じ値を使うために更新します。この変更により、画面と保存結果の不整合を防げます。"
            }
          ]
        }
      ]
    }), "Gemini");

    expect(parsed.response.toolCalls?.[0]).toEqual({
      type: "apply_patch",
      intent: "値を更新します。",
      patch,
      fileExplanations: [
        {
          path: "src/App.ts",
          explanation: "表示と保存で同じ値を使うために更新します。この変更により、画面と保存結果の不整合を防げます。"
        }
      ]
    });
    expect(parsed.repairIssues).toEqual([]);
  });

  it("keeps old apply_patch responses readable while requesting missing explanations for regeneration", () => {
    const parsed = new MentorResponseSchema().parseStrictWithDiagnostics(JSON.stringify({
      title: "応答",
      sections: [{ heading: "編集", items: ["パッチで更新します。"] }],
      policyWarnings: [],
      toolCalls: [
        {
          type: "apply_patch",
          intent: "値を更新します。",
          patch
        }
      ]
    }), "Gemini");

    expect(parsed.response.toolCalls?.[0]).toEqual({
      type: "apply_patch",
      intent: "値を更新します。",
      patch
    });
    expect(parsed.repairIssues[0]).toContain("fileExplanations");
    expect(parsed.repairIssues[0]).toContain("src/App.ts");
  });

  it("normalizes a single tool call object into an array", () => {
    const parsed = new MentorResponseSchema().parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "編集",
          items: ["パッチで更新します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: {
        type: "apply_patch",
        intent: "値を更新します。",
        patch
      }
    }), "Gemini");

    expect(parsed.toolCalls).toEqual([
      {
        type: "apply_patch",
        intent: "値を更新します。",
        patch
      }
    ]);
  });

  it("keeps valid tool calls while dropping malformed siblings", () => {
    const parsed = new MentorResponseSchema().parseStrict(JSON.stringify({
      title: "応答",
      sections: [
        {
          heading: "確認",
          items: ["テストを実行します。"]
        }
      ],
      policyWarnings: [],
      toolCalls: [
        {
          type: "unknown",
          value: "invalid"
        },
        {
          type: "run_command",
          shell: "PowerShell",
          command: "npm test",
          meaning: "テストを実行します。",
          expectedResult: "成功します。"
        }
      ]
    }), "Gemini");

    expect(parsed.toolCalls).toEqual([
      {
        type: "run_command",
        shell: "powershell",
        command: "npm test",
        workingDirectory: ".",
        meaning: "テストを実行します。",
        expectedResult: "成功します。"
      }
    ]);
    expect(parsed.policyWarnings).toContain("一部のツール提案は形式が不正だったため破棄しました。");
  });

  it("rejects old editProposal and commandProposal fields in strict mode", () => {
    const schema = new MentorResponseSchema();

    expect(() => schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [{ heading: "編集", items: ["旧形式です。"] }],
      policyWarnings: [],
      editProposal: {
        mode: "workspace",
        intent: "旧編集案",
        operations: []
      }
    }), "Gemini")).toThrow(MentorResponseSchemaError);

    expect(() => schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [{ heading: "実行", items: ["旧形式です。"] }],
      policyWarnings: [],
      commandProposal: {
        shell: "powershell",
        command: "npm test",
        workingDirectory: ".",
        meaning: "実行します。",
        expectedResult: "成功します。"
      }
    }), "Gemini")).toThrow(MentorResponseSchemaError);
  });

  it("drops invalid apply_patch tool calls in strict mode", () => {
    const schema = new MentorResponseSchema();

    const parsed = schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [{ heading: "編集", items: ["壊れた patch です。"] }],
      policyWarnings: [],
      toolCalls: [
        {
          type: "apply_patch",
          intent: "壊れた patch",
          patch: "*** Begin Patch\n*** Update File: src/App.ts\n-broken"
        }
      ]
    }), "Gemini");

    expect(parsed.toolCalls).toBeUndefined();
    expect(parsed.policyWarnings).toContain("一部のツール提案は形式が不正だったため破棄しました。");
  });

  it("reports invalid apply_patch tool calls as repair issues", () => {
    const schema = new MentorResponseSchema();

    const parsed = schema.parseStrictWithDiagnostics(JSON.stringify({
      title: "応答",
      sections: [{ heading: "編集", items: ["壊れた patch です。"] }],
      policyWarnings: [],
      toolCalls: [
        {
          type: "apply_patch",
          intent: "壊れた patch",
          patch: "*** Begin Patch\n*** Update File: src/App.ts\n-broken"
        }
      ]
    }), "Gemini");

    expect(parsed.response.toolCalls).toBeUndefined();
    expect(parsed.repairIssues[0]).toContain("toolCalls[0].patch は apply_patch として解析できません");
  });

  it("caps too many tool calls with a warning instead of failing the response", () => {
    const schema = new MentorResponseSchema();

    const parsed = schema.parseStrict(JSON.stringify({
      title: "応答",
      sections: [{ heading: "実行", items: ["多すぎる tool call です。"] }],
      policyWarnings: [],
      toolCalls: Array.from({ length: 5 }, () => ({
        type: "run_command",
        shell: "powershell",
        command: "npm test",
        workingDirectory: ".",
        meaning: "テストを実行します。",
        expectedResult: "成功します。"
      }))
    }), "Gemini");

    expect(parsed.toolCalls).toHaveLength(4);
    expect(parsed.policyWarnings).toContain("ツール提案が多すぎるため、先頭4件だけを対象にしました。");
  });

  it("keeps a fallback mentor response for non-json LLM text", () => {
    const parsed = new MentorResponseSchema().parse([
      "Spring Bootプロジェクトを作成します。",
      "pom.xml と application.properties を追加してください。"
    ].join("\n"), "Gemini");

    expect(parsed.title).toBe("メンター応答");
    expect(parsed.sections[0]?.heading).toBe("回答");
    expect(parsed.sections[0]?.items).toContain("Spring Bootプロジェクトを作成します。");
  });

  it("throws a safe schema error in strict mode instead of returning raw fallback items", () => {
    const schema = new MentorResponseSchema();

    expect(() => schema.parseStrict([
      "{",
      "\"title\":\"壊れた応答\","
    ].join("\n"), "Gemini")).toThrow(MentorResponseSchemaError);
  });

  it("keeps a fallback mentor response for invalid response fields", () => {
    const parsed = new MentorResponseSchema().parse(JSON.stringify({
      title: "応答",
      sections: 123,
      policyWarnings: []
    }), "Gemini");

    expect(parsed.title).toBe("メンター応答");
    expect(parsed.sections[0]?.heading).toBe("回答");
    expect(parsed.sections[0]?.items[0]).toContain("\"sections\":123");
  });
});
