import { describe, expect, it } from "vitest";
import { McpServerConfiguration, isMcpToolContext } from "../src/domain/mcp";

describe("McpServerConfiguration", () => {
  it("accepts HTTPS and loopback HTTP servers", () => {
    const result = new McpServerConfiguration().normalize([
      { id: "remote-tools", displayName: "Remote Tools", url: "https://mcp.example.test/mcp" },
      { id: "local-tools", displayName: "Local Tools", url: "http://127.0.0.1:3000/mcp" }
    ]);

    expect(result.issues).toEqual([]);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]?.enabled).toBe(true);
  });

  it("rejects insecure external and credential-bearing URLs", () => {
    const result = new McpServerConfiguration().normalize([
      { id: "plain", displayName: "Plain", url: "http://mcp.example.test/mcp" },
      { id: "secret", displayName: "Secret", url: "https://user:pass@mcp.example.test/mcp" },
      { id: "query", displayName: "Query", url: "https://mcp.example.test/mcp?token=secret" }
    ]);

    expect(result.servers).toEqual([]);
    expect(result.issues).toHaveLength(3);
  });

  it("normalizes HTTP auth and STDIO without accepting a shell command line", () => {
    const result = new McpServerConfiguration().normalize([
      { id: "oauth-tools", displayName: "OAuth Tools", transport: "http", url: "https://mcp.example.test/mcp", auth: "oauth" },
      { id: "local-process", displayName: "Local Process", transport: "stdio", command: "node", args: ["server.js"] }
    ]);

    expect(result.issues).toEqual([]);
    expect(result.servers).toEqual([
      expect.objectContaining({ id: "oauth-tools", transport: "http", auth: "oauth" }),
      expect.objectContaining({ id: "local-process", transport: "stdio", command: "node", args: ["server.js"], auth: "none" })
    ]);
  });
});

describe("McpToolContext", () => {
  it("accepts unique bounded tool descriptors", () => {
    expect(isMcpToolContext({
      tools: [{
        serverId: "remote-tools",
        serverName: "Remote Tools",
        name: "search.code",
        description: "Search code",
        inputSchema: { type: "object", properties: { query: { type: "string" } } }
      }]
    })).toBe(true);
  });

  it("rejects duplicate tool identities", () => {
    const tool = {
      serverId: "remote-tools",
      serverName: "Remote Tools",
      name: "search",
      inputSchema: { type: "object" }
    };
    expect(isMcpToolContext({ tools: [tool, tool] })).toBe(false);
  });
});
