import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";
import { createCustomInstructionContext } from "../src/domain/customInstructions";
import { instructionRevision } from "../src/domain/instructionSafety";
import { SKILL_CONTEXT_SCHEMA_VERSION } from "../src/domain/skills/skillContext";
import { LLM_RATE_LIMIT_MESSAGE } from "../src/domain/llmErrors";
import {
  APP_CLIENT_VERSION_ERROR_STAGE,
  MentorRequestError,
  ServerClient,
  clientVersionFromPackageJson,
  describeAppServerFetchFailureForLog,
  mentorApiErrorUserMessage
} from "../src/extension/serverClient";
import {
  validCustomInstructionReviewRequest,
  validCustomInstructionReviewResult
} from "./fixtures/customInstructionReview";

function extensionContext(): ExtensionContext {
  return {
    extension: {
      packageJSON: {
        version: "0.1.3",
        mentorClientVersion: "20260714182352"
      }
    },
    secrets: {
      get: async () => "test-local-token-1234567890"
    }
  } as unknown as ExtensionContext;
}

const emptyContextPackage = {
  files: [],
  blockedFiles: [],
  summary: {
    scannedFiles: 0,
    includedFiles: 0,
    blockedFiles: 0,
    maskedFindings: 0,
    warningFindings: 0,
    criticalFindings: 0
  }
} as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("describeAppServerFetchFailureForLog", () => {
  it("captures nested fetch failure causes without logging query strings", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
      hostname: "api.example.test"
    });
    const error = new TypeError("fetch failed", {
      cause
    });

    const log = describeAppServerFetchFailureForLog({
      label: "App Server health check",
      url: "https://api.example.test/health?token=secret#debug",
      method: "GET",
      timeoutMs: 5_000,
      timedOut: false,
      error
    });

    expect(log).toMatchObject({
      label: "App Server health check",
      method: "GET",
      protocol: "https:",
      host: "api.example.test",
      pathname: "/health",
      timeoutMs: 5_000,
      timedOut: false,
      error: {
        name: "TypeError",
        message: "fetch failed",
        cause: {
          name: "Error",
          message: "getaddrinfo ENOTFOUND api.example.test",
          code: "ENOTFOUND",
          syscall: "getaddrinfo",
          hostname: "api.example.test"
        }
      }
    });
    expect(JSON.stringify(log)).not.toContain("secret");
  });

  it("marks timeout failures distinctly", () => {
    const log = describeAppServerFetchFailureForLog({
      label: "App Server mentor request",
      url: "https://api.example.test/api/mentor",
      method: "POST",
      timeoutMs: 75_000,
      timedOut: true,
      error: new DOMException("The operation was aborted.", "AbortError")
    });

    expect(log).toMatchObject({
      label: "App Server mentor request",
      method: "POST",
      pathname: "/api/mentor",
      timedOut: true,
      error: {
        name: "AbortError",
        message: "The operation was aborted."
      }
    });
  });
});

describe("mentorApiErrorUserMessage", () => {
  it("uses a clear retry message for LLM rate limits", () => {
    expect(mentorApiErrorUserMessage(429)).toBe(LLM_RATE_LIMIT_MESSAGE);
  });

  it("keeps the generic failure message for non-rate-limit API errors", () => {
    expect(mentorApiErrorUserMessage(502)).toBe("応答を生成できませんでした。詳細はログを確認してください。");
  });

  it("keeps the server update guidance for client version errors", () => {
    const updateUrl = "https://mentor-code.ginjiro.homes/downloads/latest";

    expect(mentorApiErrorUserMessage(426, {
      error: "拡張機能のバージョンがサーバーの要求と一致しません。最新版のVSIXを再インストールしてください。",
      stage: APP_CLIENT_VERSION_ERROR_STAGE,
      updateUrl
    })).toBe([
      "拡張機能のバージョンがサーバーの要求と一致しません。最新版のVSIXを再インストールしてください。",
      updateUrl
    ].join("\n"));
  });

  it("keeps generic messaging for unrelated 426 responses", () => {
    expect(mentorApiErrorUserMessage(426, {
      error: "Upgrade required.",
      stage: "app_server"
    })).toBe("応答を生成できませんでした。詳細はログを確認してください。");
  });
});

describe("clientVersionFromPackageJson", () => {
  it("prefers the internal mentor client version from package JSON", () => {
    expect(clientVersionFromPackageJson({
      version: "0.1.3",
      mentorClientVersion: " 20260714182352 "
    })).toBe("20260714182352");
  });

  it("falls back to the SemVer extension version when no internal client version exists", () => {
    expect(clientVersionFromPackageJson({
      version: " 0.1.3 "
    })).toBe("0.1.3");
  });

  it("uses an explicit unknown fallback when package JSON has no usable version", () => {
    expect(clientVersionFromPackageJson({})).toBe("unknown");
    expect(clientVersionFromPackageJson(null)).toBe("unknown");
  });
});

describe("ServerClient", () => {
  it("sends the extension version with mentor requests", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({
      response: {
        title: "ok",
        sections: [],
        policyWarnings: []
      },
      safety: "ok"
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    })));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ServerClient(extensionContext());

    await client.createMentorResponse(
      {
        task: "相談"
      },
      emptyContextPackage,
      true
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({
      "Accept": "text/event-stream, application/json",
      "X-Mentor-Client-Version": "20260714182352",
      "X-Mentor-Request-Id": expect.stringMatching(/^req_[a-p]{32}$/)
    });
  });

  it("verifies server capability before sending custom instructions", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          capabilities: { customInstructionExecution: true }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        response: { title: "ok", sections: [], policyWarnings: [] },
        safety: "ok"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await client.createMentorResponse(
      { task: "相談" },
      emptyContextPackage,
      true,
      undefined,
      undefined,
      createCustomInstructionContext("日本語で簡潔に回答する。")
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mentorInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(mentorInit?.body ?? "{}")) as {
      readonly customInstruction?: { readonly content: string };
    };
    expect(body.customInstruction?.content).toBe("日本語で簡潔に回答する。");
  });

  it("fails closed when the server cannot apply custom instructions", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await expect(client.createMentorResponse(
      { task: "相談" },
      emptyContextPackage,
      true,
      undefined,
      undefined,
      createCustomInstructionContext("日本語で回答する。")
    )).rejects.toThrow("カスタム指示の安全な適用に対応していません");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verifies server capability before sending selected Skills", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          capabilities: { skillsExecution: true }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        response: { title: "ok", sections: [], policyWarnings: [] },
        safety: "ok"
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());
    const description = "Use for code review.";
    const instructions = "Review edge cases.";
    const combined = [description, instructions].join("\n");

    await client.createMentorResponse(
      { task: "Use $review-code." },
      emptyContextPackage,
      true,
      undefined,
      undefined,
      undefined,
      {
        activeSkills: [{
          schemaVersion: SKILL_CONTEXT_SCHEMA_VERSION,
          id: "workspace:project:review-code",
          name: "review-code",
          description,
          scope: "workspace",
          instructions,
          revision: instructionRevision(combined),
          byteLength: Buffer.byteLength(combined, "utf8")
        }]
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const mentorInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(mentorInit?.body ?? "{}")) as {
      readonly skillContext?: { readonly activeSkills: readonly { readonly name: string }[] };
    };
    expect(body.skillContext?.activeSkills[0]?.name).toBe("review-code");
  });

  it("fails closed when the server cannot apply Skills", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());
    const description = "Use for code review.";
    const instructions = "Review edge cases.";
    const combined = [description, instructions].join("\n");

    await expect(client.createMentorResponse(
      { task: "Use $review-code." },
      emptyContextPackage,
      true,
      undefined,
      undefined,
      undefined,
      {
        activeSkills: [{
          schemaVersion: SKILL_CONTEXT_SCHEMA_VERSION,
          id: "workspace:project:review-code",
          name: "review-code",
          description,
          scope: "workspace",
          instructions,
          revision: instructionRevision(combined),
          byteLength: Buffer.byteLength(combined, "utf8")
        }]
      }
    )).rejects.toThrow("Skillsの安全な適用に対応していません");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verifies server capability before sending MCP tool metadata", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const body = String(input).endsWith("/health")
        ? { ok: true, capabilities: { mcpTools: true } }
        : { response: { title: "ok", sections: [], policyWarnings: [] }, safety: "ok" };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await client.createMentorResponse(
      { task: "Issueを確認して" },
      emptyContextPackage,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        tools: [{
          serverId: "project-tools",
          serverName: "Project Tools",
          name: "lookup",
          inputSchema: { type: "object" }
        }]
      }
    );

    const mentorInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(mentorInit?.body ?? "{}")) as {
      readonly mcpContext?: { readonly tools: readonly { readonly name: string }[] };
    };
    expect(body.mcpContext?.tools[0]?.name).toBe("lookup");
  });

  it("checks selection capability and filters unknown selected ids", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const body = String(input).endsWith("/health")
        ? { ok: true, capabilities: { skillsSelection: true } }
        : { result: { selectedIds: ["workspace:project:testing", "unknown"] } };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    const result = await client.selectSkills({
      task: "テストを直して",
      catalog: [{
        id: "workspace:project:testing",
        name: "testing",
        description: "Use when fixing tests.",
        scope: "workspace"
      }]
    });

    expect(result.selectedIds).toEqual(["workspace:project:testing"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/skills/select");
  });

  it("checks review capability and returns only the matching revision", async () => {
    const request = validCustomInstructionReviewRequest();
    const result = validCustomInstructionReviewResult(request);
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          capabilities: { customInstructionReview: true }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await expect(client.createCustomInstructionReview(request)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reviewInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(reviewInit?.headers).toMatchObject({
      "X-Mentor-Client-Version": "20260714182352",
      "X-Mentor-Request-Id": expect.stringMatching(/^req_[a-p]{32}$/)
    });
  });

  it("does not send review content when the server capability is unavailable", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      capabilities: { customInstructionReview: false }
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await expect(client.createCustomInstructionReview(
      validCustomInstructionReviewRequest()
    )).rejects.toThrow("LLMレビューを利用できません");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a review response for a different AGENTS.md revision", async () => {
    const request = validCustomInstructionReviewRequest();
    const mismatched = {
      ...validCustomInstructionReviewResult(request),
      instructionRevision: "different-revision"
    };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const body = String(input).endsWith("/health")
        ? { ok: true, capabilities: { customInstructionReview: true } }
        : { result: mismatched };
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    await expect(client.createCustomInstructionReview(request)).rejects.toThrow(
      "処理段階: レビュー応答の検証"
    );
  });

  it("keeps the review failure stage and request ID visible to the user", async () => {
    const requestId = `req_${"a".repeat(32)}`;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/health")) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          capabilities: { customInstructionReview: true }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        error: "LLM応答を生成できませんでした。",
        stage: "external_llm_openai",
        requestId
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ServerClient(extensionContext());

    const error = await client.createCustomInstructionReview(
      validCustomInstructionReviewRequest()
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MentorRequestError);
    expect(error).toMatchObject({
      stage: "external_llm_openai",
      requestId,
      message: expect.stringContaining("処理段階: OpenAI API（外部LLM）")
    });
    expect((error as Error).message).toContain(`リクエストID: ${requestId}`);
  });

  it("consumes progress events and returns only the terminal result", async () => {
    const progressMessages: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const requestId = headers["X-Mentor-Request-Id"];
      const frames = [
        {
          type: "progress",
          requestId,
          sequence: 1,
          stage: "upstream_first_chunk_received",
          message: "AIから応答を受信しています。",
          elapsedMs: 120
        },
        {
          type: "result",
          requestId,
          sequence: 2,
          result: {
            response: { title: "ok", sections: [], policyWarnings: [] },
            safety: "ok"
          }
        }
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return Promise.resolve(new Response(frames, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }));
    }));
    const client = new ServerClient(extensionContext());

    const result = await client.createMentorResponse(
      { task: "相談" },
      emptyContextPackage,
      true,
      undefined,
      (event) => {
        progressMessages.push(event.message);
        return new Promise<void>(() => undefined);
      }
    );

    expect(progressMessages).toEqual(["AIから応答を受信しています。"]);
    expect(result).toEqual({
      response: { title: "ok", sections: [], policyWarnings: [] },
      safety: "ok"
    });
  });

  it("reports a hard deadline with the request ID instead of a generic error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      })
    )));
    const client = new ServerClient(extensionContext());
    const request = client.createMentorResponse({ task: "相談" }, emptyContextPackage, true);
    const assertion = expect(request).rejects.toThrow(
      /^App Serverの応答待ちが130秒を超えたため中止しました。requestId: req_[a-p]{32}$/
    );

    await vi.advanceTimersByTimeAsync(130_000);
    await assertion;
  });

  it("reports an idle stream timeout when no heartbeat or data arrives for 30 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      new ReadableStream<Uint8Array>({ start: () => undefined }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    ))));
    const client = new ServerClient(extensionContext());
    const request = client.createMentorResponse({ task: "相談" }, emptyContextPackage, true);
    const assertion = expect(request).rejects.toThrow(
      /^App Serverから30秒間データを受信できなかったため中止しました。requestId: req_[a-p]{32}$/
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
