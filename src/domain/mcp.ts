import type { GuardSummary } from "./types";

export const MAX_MCP_SERVERS = 8;
export const MAX_MCP_TOOLS_PER_SERVER = 64;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 32 * 1024;
export const MAX_MCP_RESULT_BYTES = 96 * 1024;

interface McpServerBase {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

export interface McpHttpServerDefinition extends McpServerBase {
  readonly transport?: "http";
  readonly url: string;
  readonly auth?: "none" | "bearer" | "oauth";
}

export interface McpStdioServerDefinition extends McpServerBase {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly auth: "none";
}

export type McpServerDefinition = McpHttpServerDefinition | McpStdioServerDefinition;

export interface McpToolDescriptor {
  readonly serverId: string;
  readonly serverName: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolContext {
  readonly tools: readonly McpToolDescriptor[];
}

export interface McpToolExecutionResult {
  readonly serverId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly content: string;
  readonly safetySummary: GuardSummary;
  readonly safetyNotice: string;
  readonly truncated: boolean;
}

export interface McpServerConfigurationIssue {
  readonly index: number;
  readonly message: string;
}

export interface McpServerConfigurationResult {
  readonly servers: readonly McpServerDefinition[];
  readonly issues: readonly McpServerConfigurationIssue[];
}

export class McpServerConfiguration {
  public normalize(value: unknown): McpServerConfigurationResult {
    if (!Array.isArray(value)) {
      return { servers: [], issues: [{ index: -1, message: "MCPサーバー設定は配列である必要があります。" }] };
    }

    const servers: McpServerDefinition[] = [];
    const issues: McpServerConfigurationIssue[] = [];
    const ids = new Set<string>();
    for (const [index, candidate] of value.slice(0, MAX_MCP_SERVERS).entries()) {
      const result = this.normalizeServer(candidate);
      if (typeof result === "string") {
        issues.push({ index, message: result });
        continue;
      }
      if (ids.has(result.id)) {
        issues.push({ index, message: `MCPサーバーID ${result.id} が重複しています。` });
        continue;
      }
      ids.add(result.id);
      servers.push(result);
    }
    if (value.length > MAX_MCP_SERVERS) {
      issues.push({ index: MAX_MCP_SERVERS, message: `MCPサーバーは最大 ${MAX_MCP_SERVERS} 件です。` });
    }
    return { servers, issues };
  }

  private normalizeServer(value: unknown): McpServerDefinition | string {
    if (!isRecord(value)) {
      return "MCPサーバー設定はオブジェクトである必要があります。";
    }
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
    const transport = value.transport === "stdio" ? "stdio" : "http";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64) {
      return "MCPサーバーIDは64文字以内の小文字英数字とハイフンで指定してください。";
    }
    if (!displayName || displayName.length > 100) {
      return "MCPサーバー表示名は1〜100文字で指定してください。";
    }

    if (transport === "stdio") {
      const command = typeof value.command === "string" ? value.command.trim() : "";
      const args = Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")
        ? value.args.slice(0, 32).map((arg) => arg.slice(0, 2048))
        : [];
      if (!command || command.length > 2048 || /[\r\n\0]/.test(command)) {
        return "STDIO MCPのcommandは改行を含まない1〜2048文字で指定してください。";
      }
      if (Array.isArray(value.args) && value.args.length > 32) {
        return "STDIO MCPのargsは最大32件です。";
      }
      return { id, displayName, transport, command, args, auth: "none", enabled: value.enabled !== false };
    }

    const rawUrl = typeof value.url === "string" ? value.url.trim() : "";
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return "MCPサーバーURLは絶対URLで指定してください。";
    }
    if (url.username || url.password || url.search || url.hash) {
      return "MCPサーバーURLに認証情報、クエリ、フラグメントを含めることはできません。";
    }
    const loopback = this.isLoopback(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return "外部MCPサーバーはHTTPS、HTTPはlocalhost系だけを使用できます。";
    }

    const auth = value.auth === "none" || value.auth === "oauth" ? value.auth : "bearer";
    return {
      id,
      displayName,
      transport,
      url: url.toString(),
      auth,
      enabled: value.enabled !== false
    };
  }

  private isLoopback(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
  }
}

export function isMcpToolContext(value: unknown): value is McpToolContext {
  if (!isRecord(value) || !Array.isArray(value.tools) ||
    value.tools.length > MAX_MCP_SERVERS * MAX_MCP_TOOLS_PER_SERVER) {
    return false;
  }
  const keys = new Set<string>();
  for (const tool of value.tools) {
    if (!isMcpToolDescriptor(tool)) {
      return false;
    }
    const key = `${tool.serverId}:${tool.name}`;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

function isMcpToolDescriptor(value: unknown): value is McpToolDescriptor {
  return isRecord(value) &&
    typeof value.serverId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.serverId) &&
    typeof value.serverName === "string" && value.serverName.length > 0 && value.serverName.length <= 100 &&
    typeof value.name === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value.name) &&
    (value.description === undefined ||
      (typeof value.description === "string" && value.description.length <= 4096)) &&
    isRecord(value.inputSchema) &&
    Buffer.byteLength(JSON.stringify(value.inputSchema), "utf8") <= MAX_MCP_TOOL_SCHEMA_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
