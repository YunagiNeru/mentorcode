import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiThinkingLevel, OpenAiReasoningEffort } from "./llm/reasoning";

export type LlmMode = "local" | "openai" | "gemini";
export type AppServerHost = "127.0.0.1" | "0.0.0.0";

export const DEFAULT_CLIENT_UPDATE_URL = "https://mentor-code.ginjiro.homes/downloads/latest";
export const DEFAULT_APP_SERVER_CONFIG_FILE = "app-server.config.json";

const APP_SERVER_CONFIG_KEYS = new Set([
  "openAiModel",
  "openAiReasoningEffort",
  "geminiModel",
  "geminiThinkingLevel",
  "geminiThinkingBudget",
  "geminiFallbackModel",
  "geminiFallbackThinkingLevel",
  "geminiFallbackThinkingBudget"
]);

interface AppServerSettingsFile {
  readonly openAiModel?: unknown;
  readonly openAiReasoningEffort?: unknown;
  readonly geminiModel?: unknown;
  readonly geminiThinkingLevel?: unknown;
  readonly geminiThinkingBudget?: unknown;
  readonly geminiFallbackModel?: unknown;
  readonly geminiFallbackThinkingLevel?: unknown;
  readonly geminiFallbackThinkingBudget?: unknown;
}

export interface AppServerConfig {
  readonly host: AppServerHost;
  readonly port: number;
  readonly serverToken: string;
  readonly requiredClientVersion?: string;
  readonly clientUpdateUrl: string;
  readonly llmMode: LlmMode;
  readonly openAiApiKey?: string;
  readonly openAiModel: string;
  readonly openAiReasoningEffort?: OpenAiReasoningEffort;
  readonly geminiApiKey?: string;
  readonly geminiModel: string;
  readonly geminiThinkingLevel?: GeminiThinkingLevel;
  readonly geminiThinkingBudget?: number;
  readonly geminiFallbackModel?: string;
  readonly geminiFallbackThinkingLevel?: GeminiThinkingLevel;
  readonly geminiFallbackThinkingBudget?: number;
  readonly llmMaxCalls: number;
  readonly llmMaxTransportRetries: number;
  readonly llmAttemptTimeoutMs: number;
  readonly llmTotalTimeoutMs: number;
  readonly llmRetryBaseDelayMs: number;
  readonly llmCircuitFailureThreshold: number;
  readonly llmCircuitOpenMs: number;
  readonly llmMaxConcurrentRequests: number;
  readonly mentorStreamingEnabled: boolean;
  readonly skillsExecutionEnabled: boolean;
  readonly mcpToolsEnabled: boolean;
  readonly customInstructionExecutionEnabled: boolean;
  readonly customInstructionReviewEnabled: boolean;
  readonly capabilityReviewEnabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly logFilePath?: string;
  readonly vsixDownloadDir?: string;
  readonly adminEnabled?: boolean;
  readonly databasePath?: string;
  readonly adminBootstrapFile?: string;
  readonly settingsMasterKey?: string;
  readonly auditRetentionDays?: number;
}

export class AppServerConfigLoader {
  public fromEnv(env: NodeJS.ProcessEnv = process.env): AppServerConfig {
    const file = this.readSettingsFile(env.MENTOR_APP_SERVER_CONFIG);
    const adminEnabled = this.readBoolean(env.MENTOR_ADMIN_ENABLED, "MENTOR_ADMIN_ENABLED", true);
    const serverToken = env.MENTOR_SERVER_TOKEN?.trim();
    if (!serverToken) {
      throw new Error("MENTOR_SERVER_TOKEN is required. Generate a local token before starting the app server.");
    }

    const llmMode = this.readLlmMode(env.MENTOR_LLM_MODE);
    const openAiApiKey = env.OPENAI_API_KEY?.trim();
    if (llmMode === "openai" && !openAiApiKey && !adminEnabled) {
      throw new Error("OPENAI_API_KEY is required when MENTOR_LLM_MODE=openai.");
    }

    const geminiApiKey = env.GEMINI_API_KEY?.trim();
    if (llmMode === "gemini" && !geminiApiKey && !adminEnabled) {
      throw new Error("GEMINI_API_KEY is required when MENTOR_LLM_MODE=gemini.");
    }
    const openAiModel = this.readModel(
      this.setting(env, file, "OPENAI_MODEL", "openAiModel"),
      "OPENAI_MODEL",
      "gpt-5.4-mini"
    );
    const openAiReasoningEffort = this.readOptionalOpenAiReasoningEffort(
      this.setting(env, file, "OPENAI_REASONING_EFFORT", "openAiReasoningEffort"),
      "OPENAI_REASONING_EFFORT"
    );
    const geminiModel = this.readModel(
      this.setting(env, file, "GEMINI_MODEL", "geminiModel"),
      "GEMINI_MODEL",
      "gemini-3.5-flash"
    );
    const geminiThinkingLevel = this.readOptionalGeminiThinkingLevel(
      this.setting(env, file, "GEMINI_THINKING_LEVEL", "geminiThinkingLevel"),
      "GEMINI_THINKING_LEVEL"
    );
    const geminiThinkingBudget = this.readOptionalInteger(
      this.setting(env, file, "GEMINI_THINKING_BUDGET", "geminiThinkingBudget"),
      "GEMINI_THINKING_BUDGET",
      0,
      1_000_000
    );
    const geminiFallbackModel = this.readOptionalModel(
      this.setting(env, file, "GEMINI_FALLBACK_MODEL", "geminiFallbackModel"),
      "GEMINI_FALLBACK_MODEL"
    );
    const geminiFallbackThinkingLevel = this.readOptionalGeminiThinkingLevel(
      this.setting(env, file, "GEMINI_FALLBACK_THINKING_LEVEL", "geminiFallbackThinkingLevel"),
      "GEMINI_FALLBACK_THINKING_LEVEL"
    );
    const geminiFallbackThinkingBudget = this.readOptionalInteger(
      this.setting(env, file, "GEMINI_FALLBACK_THINKING_BUDGET", "geminiFallbackThinkingBudget"),
      "GEMINI_FALLBACK_THINKING_BUDGET",
      0,
      1_000_000
    );
    if (geminiFallbackModel === geminiModel) {
      throw new Error("GEMINI_FALLBACK_MODEL must differ from GEMINI_MODEL.");
    }
    this.validateThinkingConfiguration(
      geminiThinkingLevel,
      geminiThinkingBudget,
      "GEMINI_THINKING_LEVEL",
      "GEMINI_THINKING_BUDGET"
    );
    this.validateThinkingConfiguration(
      geminiFallbackThinkingLevel,
      geminiFallbackThinkingBudget,
      "GEMINI_FALLBACK_THINKING_LEVEL",
      "GEMINI_FALLBACK_THINKING_BUDGET"
    );
    if ((geminiFallbackThinkingLevel !== undefined || geminiFallbackThinkingBudget !== undefined) && !geminiFallbackModel) {
      throw new Error("Gemini fallback thinking settings require GEMINI_FALLBACK_MODEL.");
    }

    const llmMaxCalls = this.readInteger(env.MENTOR_LLM_MAX_CALLS, "MENTOR_LLM_MAX_CALLS", 3, 1, 5);
    const llmMaxTransportRetries = this.readInteger(
      env.MENTOR_LLM_MAX_TRANSPORT_RETRIES,
      "MENTOR_LLM_MAX_TRANSPORT_RETRIES",
      1,
      0,
      4
    );
    const llmAttemptTimeoutMs = this.readInteger(
      env.MENTOR_LLM_ATTEMPT_TIMEOUT_MS,
      "MENTOR_LLM_ATTEMPT_TIMEOUT_MS",
      45_000,
      1_000,
      120_000
    );
    const llmTotalTimeoutMs = this.readInteger(
      env.MENTOR_LLM_TOTAL_TIMEOUT_MS,
      "MENTOR_LLM_TOTAL_TIMEOUT_MS",
      105_000,
      2_000,
      240_000
    );
    const llmRetryBaseDelayMs = this.readInteger(
      env.MENTOR_LLM_RETRY_BASE_DELAY_MS,
      "MENTOR_LLM_RETRY_BASE_DELAY_MS",
      1_000,
      0,
      30_000
    );
    const llmCircuitFailureThreshold = this.readInteger(
      env.MENTOR_LLM_CIRCUIT_FAILURE_THRESHOLD,
      "MENTOR_LLM_CIRCUIT_FAILURE_THRESHOLD",
      3,
      1,
      20
    );
    const llmCircuitOpenMs = this.readInteger(
      env.MENTOR_LLM_CIRCUIT_OPEN_MS,
      "MENTOR_LLM_CIRCUIT_OPEN_MS",
      30_000,
      1_000,
      600_000
    );
    const llmMaxConcurrentRequests = this.readInteger(
      env.MENTOR_LLM_MAX_CONCURRENT_REQUESTS,
      "MENTOR_LLM_MAX_CONCURRENT_REQUESTS",
      4,
      1,
      100
    );
    const mentorStreamingEnabled = this.readBoolean(
      env.MENTOR_STREAMING_ENABLED,
      "MENTOR_STREAMING_ENABLED",
      false
    );
    const skillsExecutionEnabled = this.readBoolean(
      env.MENTOR_SKILLS_EXECUTION_ENABLED,
      "MENTOR_SKILLS_EXECUTION_ENABLED",
      true
    );
    const mcpToolsEnabled = this.readBoolean(
      env.MENTOR_MCP_TOOLS_ENABLED,
      "MENTOR_MCP_TOOLS_ENABLED",
      true
    );
    const customInstructionExecutionEnabled = this.readBoolean(
      env.MENTOR_CUSTOM_INSTRUCTION_EXECUTION_ENABLED,
      "MENTOR_CUSTOM_INSTRUCTION_EXECUTION_ENABLED",
      true
    );
    const customInstructionReviewEnabled = this.readBoolean(
      env.MENTOR_CUSTOM_INSTRUCTION_REVIEW_ENABLED,
      "MENTOR_CUSTOM_INSTRUCTION_REVIEW_ENABLED",
      true
    );
    const capabilityReviewEnabled = this.readBoolean(
      env.MENTOR_CAPABILITY_REVIEW_ENABLED,
      "MENTOR_CAPABILITY_REVIEW_ENABLED",
      true
    );
    this.validateAvailabilityPolicy({
      llmMaxCalls,
      llmMaxTransportRetries,
      llmAttemptTimeoutMs,
      llmTotalTimeoutMs,
      llmRetryBaseDelayMs,
      llmCircuitFailureThreshold,
      llmCircuitOpenMs
    });

    return {
      host: this.readHost(env.MENTOR_SERVER_HOST),
      port: this.readPort(env.MENTOR_SERVER_PORT),
      serverToken,
      ...this.readRequiredClientVersion(env.MENTOR_REQUIRED_CLIENT_VERSION),
      clientUpdateUrl: this.readClientUpdateUrl(env.MENTOR_CLIENT_UPDATE_URL),
      llmMode,
      ...(openAiApiKey ? { openAiApiKey } : {}),
      openAiModel,
      ...(openAiReasoningEffort ? { openAiReasoningEffort } : {}),
      ...(geminiApiKey ? { geminiApiKey } : {}),
      geminiModel,
      ...(geminiThinkingLevel ? { geminiThinkingLevel } : {}),
      ...(geminiThinkingBudget === undefined ? {} : { geminiThinkingBudget }),
      ...(geminiFallbackModel ? { geminiFallbackModel } : {}),
      ...(geminiFallbackThinkingLevel ? { geminiFallbackThinkingLevel } : {}),
      ...(geminiFallbackThinkingBudget === undefined ? {} : { geminiFallbackThinkingBudget }),
      llmMaxCalls,
      llmMaxTransportRetries,
      llmAttemptTimeoutMs,
      llmTotalTimeoutMs,
      llmRetryBaseDelayMs,
      llmCircuitFailureThreshold,
      llmCircuitOpenMs,
      llmMaxConcurrentRequests,
      mentorStreamingEnabled,
      skillsExecutionEnabled,
      mcpToolsEnabled,
      customInstructionExecutionEnabled,
      customInstructionReviewEnabled,
      capabilityReviewEnabled,
      allowedOrigins: this.readAllowedOrigins(env.MENTOR_ALLOWED_ORIGINS),
      logFilePath: env.MENTOR_APP_SERVER_LOG_FILE?.trim() || join(process.cwd(), ".mentor-code", "logs", "app-server.log"),
      vsixDownloadDir: env.MENTOR_VSIX_DOWNLOAD_DIR?.trim() || join(process.cwd(), "downloads")
      ,adminEnabled
      ,databasePath: env.MENTOR_DATABASE_PATH?.trim() || join(process.cwd(), ".mentor-code", "data", "app.db")
      ,...(env.MENTOR_ADMIN_BOOTSTRAP_FILE?.trim() ? { adminBootstrapFile: env.MENTOR_ADMIN_BOOTSTRAP_FILE.trim() } : {})
      ,...(env.MENTOR_SETTINGS_MASTER_KEY?.trim() ? { settingsMasterKey: env.MENTOR_SETTINGS_MASTER_KEY.trim() } : {})
      ,auditRetentionDays: this.readInteger(env.MENTOR_AUDIT_RETENTION_DAYS, "MENTOR_AUDIT_RETENTION_DAYS", 90, 1, 3650)
    };
  }

  private readSettingsFile(pathOverride: string | undefined): AppServerSettingsFile {
    const explicitPath = pathOverride?.trim();
    const path = explicitPath || join(process.cwd(), DEFAULT_APP_SERVER_CONFIG_FILE);
    if (!explicitPath && !existsSync(path)) {
      return {};
    }

    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`App Server config file could not be read: ${path}.`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`App Server config file must contain valid JSON: ${path}.`, { cause: error });
    }

    if (!this.isRecord(parsed)) {
      throw new Error("App Server config file must contain a JSON object.");
    }

    const unknownKeys = Object.keys(parsed).filter((key) => !APP_SERVER_CONFIG_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`App Server config file contains unsupported keys: ${unknownKeys.join(", ")}.`);
    }

    return parsed;
  }

  private setting(
    env: NodeJS.ProcessEnv,
    file: AppServerSettingsFile,
    envName: string,
    fileKey: keyof AppServerSettingsFile
  ): unknown {
    const environmentValue = env[envName];
    if (environmentValue !== undefined && environmentValue.trim().length > 0) {
      return environmentValue;
    }
    return file[fileKey];
  }

  private isRecord(value: unknown): value is AppServerSettingsFile {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private readModel(value: unknown, name: string, defaultValue: string): string {
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return defaultValue;
    }
    if (typeof value !== "string") {
      throw new Error(`${name} must be a valid provider model ID.`);
    }
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
      throw new Error(`${name} must be a valid provider model ID.`);
    }
    return trimmed;
  }

  private readHost(value: string | undefined): AppServerHost {
    if (!value) {
      return "127.0.0.1";
    }

    const trimmed = value.trim();
    if (trimmed === "127.0.0.1" || trimmed === "0.0.0.0") {
      return trimmed;
    }

    throw new Error("MENTOR_SERVER_HOST must be 127.0.0.1 or 0.0.0.0.");
  }

  private readPort(value: string | undefined): number {
    if (!value) {
      return 8787;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      throw new Error("MENTOR_SERVER_PORT must be an integer from 1024 to 65535.");
    }

    return parsed;
  }

  private readInteger(
    value: string | undefined,
    name: string,
    defaultValue: number,
    minimum: number,
    maximum: number
  ): number {
    if (value === undefined || value.trim().length === 0) {
      return defaultValue;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }

    return parsed;
  }

  private readOptionalModel(value: unknown, name: string): string | undefined {
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`${name} must be a valid provider model ID.`);
    }
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
      throw new Error(`${name} must be a valid provider model ID.`);
    }
    return trimmed;
  }

  private readOptionalOpenAiReasoningEffort(
    value: unknown,
    name: string
  ): OpenAiReasoningEffort | undefined {
    const normalized = this.readOptionalSettingString(value, name);
    if (normalized === undefined) {
      return undefined;
    }
    if (["none", "minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
      return normalized as OpenAiReasoningEffort;
    }
    throw new Error(`${name} must be none, minimal, low, medium, high, or xhigh.`);
  }

  private readOptionalGeminiThinkingLevel(
    value: unknown,
    name: string
  ): GeminiThinkingLevel | undefined {
    const normalized = this.readOptionalSettingString(value, name);
    if (normalized === undefined) {
      return undefined;
    }
    if (["minimal", "low", "medium", "high"].includes(normalized)) {
      return normalized as GeminiThinkingLevel;
    }
    throw new Error(`${name} must be minimal, low, medium, or high.`);
  }

  private readOptionalSettingString(value: unknown, name: string): string | undefined {
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new Error(`${name} must be a string.`);
    }
    return value.trim();
  }

  private readOptionalInteger(
    value: unknown,
    name: string,
    minimum: number,
    maximum: number
  ): number | undefined {
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      return undefined;
    }

    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  }

  private validateThinkingConfiguration(
    thinkingLevel: GeminiThinkingLevel | undefined,
    thinkingBudget: number | undefined,
    levelName: string,
    budgetName: string
  ): void {
    if (thinkingLevel !== undefined && thinkingBudget !== undefined) {
      throw new Error(`${levelName} and ${budgetName} cannot be configured together.`);
    }
  }

  private readBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    throw new Error(`${name} must be true or false.`);
  }

  private validateAvailabilityPolicy(policy: Pick<
    AppServerConfig,
    | "llmMaxCalls"
    | "llmMaxTransportRetries"
    | "llmAttemptTimeoutMs"
    | "llmTotalTimeoutMs"
    | "llmRetryBaseDelayMs"
    | "llmCircuitFailureThreshold"
    | "llmCircuitOpenMs"
  >): void {
    if (policy.llmMaxTransportRetries >= policy.llmMaxCalls) {
      throw new Error("MENTOR_LLM_MAX_TRANSPORT_RETRIES must be less than MENTOR_LLM_MAX_CALLS.");
    }
    if (policy.llmAttemptTimeoutMs >= policy.llmTotalTimeoutMs) {
      throw new Error("MENTOR_LLM_ATTEMPT_TIMEOUT_MS must be less than MENTOR_LLM_TOTAL_TIMEOUT_MS.");
    }
    if (policy.llmRetryBaseDelayMs >= policy.llmTotalTimeoutMs) {
      throw new Error("MENTOR_LLM_RETRY_BASE_DELAY_MS must be less than MENTOR_LLM_TOTAL_TIMEOUT_MS.");
    }
  }

  private readRequiredClientVersion(value: string | undefined): Partial<Pick<AppServerConfig, "requiredClientVersion">> {
    const trimmed = value?.trim();
    return trimmed ? { requiredClientVersion: trimmed } : {};
  }

  private readClientUpdateUrl(value: string | undefined): string {
    const raw = value?.trim() || DEFAULT_CLIENT_UPDATE_URL;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("MENTOR_CLIENT_UPDATE_URL must be an http or https absolute URL.");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("MENTOR_CLIENT_UPDATE_URL must start with http or https.");
    }

    if (parsed.username || parsed.password) {
      throw new Error("MENTOR_CLIENT_UPDATE_URL must not include credentials.");
    }

    parsed.hash = "";
    return parsed.toString();
  }

  private readLlmMode(value: string | undefined): LlmMode {
    if (!value) {
      return "local";
    }

    if (value === "local" || value === "openai" || value === "gemini") {
      return value;
    }

    throw new Error("MENTOR_LLM_MODE must be local, openai, or gemini.");
  }

  private readAllowedOrigins(value: string | undefined): readonly string[] {
    const defaults = [
      "https://api.mentor-code.ginjiro.homes",
      "https://mentor-code.ginjiro.homes",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "vscode-webview://"
    ];

    if (!value) {
      return defaults;
    }

    return [
      ...defaults,
      ...value.split(",").map((origin) => origin.trim()).filter(Boolean)
    ];
  }
}
