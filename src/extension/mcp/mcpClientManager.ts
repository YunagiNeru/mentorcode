import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type JsonSchemaType,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  type Tool
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomUUID } from "node:crypto";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_TOOLS_PER_SERVER,
  type McpServerDefinition,
  type McpToolContext,
  type McpToolDescriptor,
  type McpToolExecutionResult
} from "../../domain/mcp";
import { PrivacyGuard } from "../../domain/privacy/privacyGuard";
import type { FileGuardResult, GuardSummary } from "../../domain/types";

export interface McpConnection {
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpSecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface McpConnector {
  connect(server: McpServerDefinition, token: string | undefined): Promise<McpConnection>;
  completeOAuth?(server: McpServerDefinition, callbackParams: URLSearchParams): Promise<void>;
  clearOAuth?(serverId: string): Promise<void>;
}

export interface McpOAuthHost {
  redirectUrl(serverId: string): string;
  openAuthorization(url: URL): Promise<void>;
}

export interface McpDiscoveryResult {
  readonly context?: McpToolContext;
  readonly issues: readonly string[];
}

export interface McpToolInvocation {
  readonly serverId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

class SecretStorageOAuthProvider implements OAuthClientProvider {
  public constructor(
    private readonly server: McpServerDefinition & { readonly url: string },
    private readonly secrets: McpSecretStore,
    private readonly host: McpOAuthHost
  ) {}

  public get redirectUrl(): string { return this.host.redirectUrl(this.server.id); }
  public get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Mentor Code",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }
  public state(): Promise<string> { return this.loadOrCreateState(); }
  public clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    return this.readJson(this.key("client", ctx));
  }
  public async saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.secrets.store(this.key("client", ctx), JSON.stringify(value));
  }
  public tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    return this.readJson(this.key("tokens", ctx));
  }
  public async saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.secrets.store(this.key("tokens", ctx), JSON.stringify(value));
  }
  public redirectToAuthorization(url: URL): Promise<void> { return this.host.openAuthorization(url); }
  public async saveCodeVerifier(value: string): Promise<void> { await this.secrets.store(this.key("verifier"), value); }
  public async codeVerifier(): Promise<string> {
    const value = await this.secrets.get(this.key("verifier"));
    if (!value) throw new Error("OAuth PKCE検証情報がありません。認証を最初からやり直してください。");
    return value;
  }
  public async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.secrets.store(this.key("discovery"), JSON.stringify(value));
  }
  public discoveryState(): Promise<OAuthDiscoveryState | undefined> { return this.readJson(this.key("discovery")); }
  public async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const names = scope === "all" ? ["client", "tokens", "verifier", "discovery", "state"] : [scope];
    await Promise.all(names.map((name) => this.secrets.delete(this.key(name))));
  }
  public async validateState(value: string): Promise<boolean> {
    const expected = await this.secrets.get(this.key("state"));
    return Boolean(expected && value && expected === value);
  }

  private async loadOrCreateState(): Promise<string> {
    const existing = await this.secrets.get(this.key("state"));
    if (existing) return existing;
    const value = randomUUID();
    await this.secrets.store(this.key("state"), value);
    return value;
  }
  private async readJson<T>(key: string): Promise<T | undefined> {
    const value = await this.secrets.get(key);
    if (!value) return undefined;
    try { return JSON.parse(value) as T; } catch { await this.secrets.delete(key); return undefined; }
  }
  private key(kind: string, _ctx?: OAuthClientInformationContext): string {
    return `mcp.server.${this.server.id}.oauth.${kind}`;
  }
}

class OfficialMcpConnector implements McpConnector {
  public constructor(
    private readonly clientVersion: string,
    private readonly secrets: McpSecretStore,
    private readonly oauthHost?: McpOAuthHost
  ) {}

  public async connect(server: McpServerDefinition, token: string | undefined): Promise<McpConnection> {
    if (server.transport === "stdio") {
      const client = new Client({ name: "mentor-code", version: this.clientVersion });
      const transport = new StdioClientTransport({ command: server.command, args: [...server.args], stderr: "pipe" });
      await client.connect(transport);
      return this.connection(client);
    }
    const serverUrl = new URL(server.url);
    const client = new Client({ name: "mentor-code", version: this.clientVersion });
    const oauthProvider = server.auth === "oauth" ? this.oauthProvider(server) : undefined;
    const transport = new StreamableHTTPClientTransport(serverUrl, {
      ...(oauthProvider ? { authProvider: oauthProvider } : token ? { authProvider: { token: async () => token } } : {}),
      fetch: async (input, init) => {
        const target = new URL(input.toString());
        if (target.origin !== serverUrl.origin && server.auth !== "oauth") {
          throw new Error("MCP request origin changed unexpectedly.");
        }
        const loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
        if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
          throw new Error("MCP OAuth request attempted an insecure external endpoint.");
        }
        return fetch(input, {
          ...init,
          redirect: "error",
          cache: "no-store"
        });
      }
    });
    await client.connect(transport);
    return this.connection(client);
  }

  public async completeOAuth(server: McpServerDefinition, callbackParams: URLSearchParams): Promise<void> {
    if (server.transport !== "http" || server.auth !== "oauth") throw new Error("OAuth対象のMCPサーバーではありません。");
    const provider = this.oauthProvider(server);
    if (!await provider.validateState(callbackParams.get("state") ?? "")) {
      throw new Error("OAuth stateが一致しないため認証結果を破棄しました。");
    }
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider });
    await transport.finishAuth(callbackParams);
    await this.secrets.delete(`mcp.server.${server.id}.oauth.state`);
  }

  public async clearOAuth(serverId: string): Promise<void> {
    await Promise.all(["client", "tokens", "verifier", "discovery", "state"].map((kind) => this.secrets.delete(`mcp.server.${serverId}.oauth.${kind}`)));
  }

  private oauthProvider(server: McpServerDefinition & { readonly url: string }): SecretStorageOAuthProvider {
    if (!this.oauthHost) throw new Error("OAuthコールバックを処理できるホストがありません。");
    return new SecretStorageOAuthProvider(server, this.secrets, this.oauthHost);
  }

  private connection(client: Client): McpConnection {
    return {
      listTools: async () => (await client.listTools()).tools,
      callTool: (name, args) => client.callTool({ name, arguments: args }),
      close: () => client.close()
    };
  }
}

export class McpClientManager {
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly connector: McpConnector;

  public constructor(
    private readonly secrets: McpSecretStore,
    private readonly servers: () => readonly McpServerDefinition[],
    clientVersion: string,
    private readonly guard = new PrivacyGuard(),
    connector?: McpConnector,
    oauthHost?: McpOAuthHost
  ) {
    this.connector = connector ?? new OfficialMcpConnector(clientVersion, secrets, oauthHost);
  }

  public async setToken(serverId: string, token: string): Promise<void> {
    const trimmed = token.trim();
    if (!this.server(serverId)) {
      throw new Error("対象のMCPサーバー設定が見つかりません。");
    }
    if (!trimmed) {
      await this.clearToken(serverId);
      return;
    }
    await this.secrets.store(this.tokenKey(serverId), trimmed);
  }

  public clearToken(serverId: string): Thenable<void> {
    return this.secrets.delete(this.tokenKey(serverId));
  }

  public async completeOAuth(serverId: string, callbackParams: URLSearchParams): Promise<void> {
    const server = this.server(serverId);
    if (!server || !this.connector.completeOAuth) throw new Error("OAuth対象のMCPサーバーが見つかりません。");
    await this.connector.completeOAuth(server, callbackParams);
  }

  public async clearAuthentication(serverId: string): Promise<void> {
    await this.clearToken(serverId);
    await this.connector.clearOAuth?.(serverId);
  }

  public async discoverTools(serverIds?: readonly string[]): Promise<McpDiscoveryResult> {
    const tools: McpToolDescriptor[] = [];
    const issues: string[] = [];
    const requested = serverIds ? new Set(serverIds) : undefined;
    for (const server of this.servers().filter((entry) => entry.enabled && (!requested || requested.has(entry.id)))) {
      let connection: McpConnection | undefined;
      try {
        connection = await this.connector.connect(server, await this.token(server.id));
        const listed = await connection.listTools();
        if (listed.length > MAX_MCP_TOOLS_PER_SERVER) {
          issues.push(`${server.displayName}: Tools数が上限 ${MAX_MCP_TOOLS_PER_SERVER} 件を超えたため切り詰めました。`);
        }
        for (const tool of listed.slice(0, MAX_MCP_TOOLS_PER_SERVER)) {
          const descriptor = this.safeDescriptor(server, tool);
          if (descriptor) {
            tools.push(descriptor);
          } else {
            issues.push(`${server.displayName}: 安全確認または形式確認に失敗したToolを除外しました。`);
          }
        }
      } catch {
        issues.push(`${server.displayName}: 接続またはTools一覧の取得に失敗しました。`);
      } finally {
        await connection?.close().catch(() => undefined);
      }
    }
    return {
      ...(tools.length > 0 ? { context: { tools } } : {}),
      issues
    };
  }

  public async callTool(invocation: McpToolInvocation): Promise<McpToolExecutionResult> {
    const server = this.server(invocation.serverId);
    if (!server || !server.enabled) {
      throw new Error("対象のMCPサーバーは未設定または無効です。");
    }

    let connection: McpConnection | undefined;
    try {
      connection = await this.connector.connect(server, await this.token(server.id));
      const tools = await connection.listTools();
      const tool = tools.find((candidate) => candidate.name === invocation.toolName);
      if (!tool) {
        throw new Error("対象のMCP Toolが現在のサーバー一覧にありません。");
      }
      this.assertArguments(tool, invocation.arguments);
      const result = await connection.callTool(tool.name, invocation.arguments);
      return this.sanitizeResult(server.id, tool.name, result);
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }

  private safeDescriptor(server: McpServerDefinition, tool: Tool): McpToolDescriptor | undefined {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || !this.isRecord(tool.inputSchema)) {
      return undefined;
    }
    const raw = JSON.stringify({
      description: tool.description ?? "",
      inputSchema: tool.inputSchema
    });
    const result = this.guard.analyzeFile({
      path: `mcp/${server.id}/${tool.name}.json`,
      content: raw,
      sizeBytes: Buffer.byteLength(raw, "utf8")
    });
    if (this.hasUnsafeFinding(result)) {
      return undefined;
    }
    return {
      serverId: server.id,
      serverName: server.displayName,
      name: tool.name,
      ...(tool.description ? { description: tool.description.slice(0, 4096) } : {}),
      inputSchema: tool.inputSchema
    };
  }

  private assertArguments(tool: Tool, args: Record<string, unknown>): void {
    if (!this.isRecord(tool.inputSchema)) {
      throw new Error("MCP ToolのinputSchemaが不正です。");
    }
    const validate = this.validator.getValidator<Record<string, unknown>>(tool.inputSchema as JsonSchemaType);
    const result = validate(args);
    if (!result.valid) {
      throw new Error(`MCP Toolの引数がinputSchemaに適合しません: ${result.errorMessage}`);
    }
  }

  private sanitizeResult(serverId: string, toolName: string, result: CallToolResult): McpToolExecutionResult {
    const serialized = this.serializeResult(result);
    const limited = this.truncateUtf8(serialized, MAX_MCP_RESULT_BYTES);
    const guardResult = this.guard.analyzeFile({
      path: `mcp-results/${serverId}/${toolName}.txt`,
      content: limited.content,
      sizeBytes: Buffer.byteLength(limited.content, "utf8")
    });
    const blocked = guardResult.blocked || guardResult.excluded || guardResult.maskedContent === undefined;
    return {
      serverId,
      toolName,
      isError: result.isError === true || blocked,
      content: blocked
        ? "[Privacy GuardによりMCP Tool結果を会話へ渡せませんでした。]"
        : guardResult.maskedContent,
      safetySummary: this.summary(guardResult, blocked),
      safetyNotice: blocked
        ? "MCP Tool結果に外部送信できない情報候補があるため内容を遮断しました。"
        : "MCP Tool結果をPrivacy Guardで検査しました。",
      truncated: limited.truncated
    };
  }

  private serializeResult(result: CallToolResult): string {
    const content = result.content.map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "resource") {
        return JSON.stringify(item.resource);
      }
      if (item.type === "resource_link") {
        return JSON.stringify({ name: item.name, uri: item.uri, description: item.description });
      }
      return `[${item.type} content omitted]`;
    });
    if (result.structuredContent !== undefined) {
      content.push(JSON.stringify(result.structuredContent));
    }
    return content.join("\n");
  }

  private truncateUtf8(content: string, maxBytes: number): { readonly content: string; readonly truncated: boolean } {
    if (Buffer.byteLength(content, "utf8") <= maxBytes) {
      return { content, truncated: false };
    }
    let end = Math.min(content.length, maxBytes);
    while (end > 0 && Buffer.byteLength(content.slice(0, end), "utf8") > maxBytes) {
      end -= 1;
    }
    return { content: content.slice(0, end), truncated: true };
  }

  private summary(result: FileGuardResult, blocked: boolean): GuardSummary {
    return {
      scannedFiles: 1,
      includedFiles: blocked ? 0 : 1,
      blockedFiles: blocked ? 1 : 0,
      maskedFindings: result.findings.filter((finding) => finding.action === "mask").length,
      warningFindings: result.findings.filter((finding) => finding.action === "warn").length,
      criticalFindings: result.findings.filter((finding) => finding.severity === "critical").length
    };
  }

  private hasUnsafeFinding(result: FileGuardResult): boolean {
    return result.blocked || result.excluded || result.maskedContent === undefined ||
      result.findings.some((finding) => finding.action === "mask" || finding.action === "block");
  }

  private server(serverId: string): McpServerDefinition | undefined {
    return this.servers().find((entry) => entry.id === serverId);
  }

  private token(serverId: string): Thenable<string | undefined> {
    return this.secrets.get(this.tokenKey(serverId));
  }

  private tokenKey(serverId: string): string {
    return `mcp.server.${serverId}.bearerToken`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
