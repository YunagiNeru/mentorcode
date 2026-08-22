import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import type { McpServerDefinition } from "../src/domain/mcp";
import {
  McpClientManager,
  type McpConnection,
  type McpConnector,
  type McpSecretStore
} from "../src/extension/mcp/mcpClientManager";

class MemorySecrets implements McpSecretStore {
  private readonly values = new Map<string, string>();
  public get(key: string): Thenable<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Thenable<void> { this.values.delete(key); return Promise.resolve(); }
}

class FakeConnector implements McpConnector {
  public token: string | undefined;
  public connectedServerIds: string[] = [];
  public completedOAuth: { readonly serverId: string; readonly code: string } | undefined;
  public calls: { readonly name: string; readonly args: Record<string, unknown> }[] = [];
  public constructor(
    private readonly tools: readonly Tool[],
    private readonly result: CallToolResult = { content: [{ type: "text", text: "ok" }] }
  ) {}

  public connect(server: McpServerDefinition, token: string | undefined): Promise<McpConnection> {
    this.token = token;
    this.connectedServerIds.push(server.id);
    return Promise.resolve({
      listTools: () => Promise.resolve(this.tools),
      callTool: (name, args) => {
        this.calls.push({ name, args });
        return Promise.resolve(this.result);
      },
      close: () => Promise.resolve()
    });
  }

  public completeOAuth(server: McpServerDefinition, callbackParams: URLSearchParams): Promise<void> {
    this.completedOAuth = { serverId: server.id, code: callbackParams.get("code") ?? "" };
    return Promise.resolve();
  }
}

const server: McpServerDefinition = {
  id: "test-server",
  displayName: "Test Server",
  url: "https://mcp.example.test/mcp",
  enabled: true
};
const tool: Tool = {
  name: "lookup",
  description: "Look up an item",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false
  }
};

describe("McpClientManager", () => {
  it("discovers safe tool metadata and reads bearer tokens from secret storage", async () => {
    const secrets = new MemorySecrets();
    const connector = new FakeConnector([tool]);
    const manager = new McpClientManager(
      secrets,
      () => [server],
      "1.0.0",
      new PrivacyGuard(),
      connector
    );
    await manager.setToken(server.id, "secret-token");

    const result = await manager.discoverTools();

    expect(result.context?.tools[0]).toMatchObject({ serverId: server.id, name: "lookup" });
    expect(connector.token).toBe("secret-token");
  });

  it("validates arguments before calling a tool", async () => {
    const connector = new FakeConnector([tool]);
    const manager = new McpClientManager(
      new MemorySecrets(),
      () => [server],
      "1.0.0",
      new PrivacyGuard(),
      connector
    );

    await expect(manager.callTool({ serverId: server.id, toolName: "lookup", arguments: {} }))
      .rejects.toThrow("inputSchema");
    expect(connector.calls).toEqual([]);
  });

  it("masks sensitive text results before returning them", async () => {
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";
    const connector = new FakeConnector([tool], {
      content: [{ type: "text", text: `API_KEY=${fakeKey}` }]
    });
    const manager = new McpClientManager(
      new MemorySecrets(),
      () => [server],
      "1.0.0",
      new PrivacyGuard(),
      connector
    );

    const result = await manager.callTool({
      serverId: server.id,
      toolName: "lookup",
      arguments: { id: "one" }
    });

    expect(result.content).not.toContain(fakeKey);
    expect(result.safetySummary.maskedFindings).toBeGreaterThan(0);
  });

  it("connects only explicitly requested servers and delegates OAuth completion", async () => {
    const oauthServer: McpServerDefinition = {
      id: "oauth-server",
      displayName: "OAuth Server",
      transport: "http",
      url: "https://oauth.example.test/mcp",
      auth: "oauth",
      enabled: true
    };
    const connector = new FakeConnector([tool]);
    const manager = new McpClientManager(new MemorySecrets(), () => [server, oauthServer], "1.0.0", new PrivacyGuard(), connector);

    await manager.discoverTools([oauthServer.id]);
    await manager.completeOAuth(oauthServer.id, new URLSearchParams("code=approved"));

    expect(connector.connectedServerIds).toEqual([oauthServer.id]);
    expect(connector.completedOAuth).toEqual({ serverId: oauthServer.id, code: "approved" });
  });
});
