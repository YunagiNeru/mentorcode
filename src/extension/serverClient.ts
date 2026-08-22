import * as vscode from "vscode";
import { DEFAULT_APP_SERVER_URL, normalizeAppServerUrl } from "../domain/appServerUrl";
import type { CustomInstructionContext } from "../domain/customInstructions";
import {
  CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION,
  CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION,
  type CustomInstructionReviewRequest,
  type CustomInstructionReviewResult
} from "../domain/customInstructionReview";
import { createMentorRequestId } from "../domain/requestId";
import { LLM_RATE_LIMIT_MESSAGE } from "../domain/llmErrors";
import type {
  MentorStreamErrorEvent,
  MentorStreamProgressEvent,
  MentorStreamResultEvent
} from "../domain/mentorProgress";
import { SseEventDecoder } from "../domain/sseDecoder";
import type { ContextPackage, ConversationContext, MentorRequest, MentorResponse } from "../domain/types";
import type { SkillExecutionContext } from "../domain/skills/skillExecution";
import {
  SkillSelectionParser,
  type SkillSelectionRequest,
  type SkillSelectionResult
} from "../domain/skills/skillSelection";
import type { McpToolContext } from "../domain/mcp";
import {
  CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION,
  type CapabilityReviewRequest,
  type CapabilityReviewResult
} from "../domain/capabilityReview";

interface MentorApiResponse {
  readonly response: MentorResponse;
  readonly safety: string;
}

interface CustomInstructionReviewApiResponse {
  readonly result: CustomInstructionReviewResult;
}

interface SkillSelectionApiResponse {
  readonly result: unknown;
}

interface CapabilityReviewApiResponse {
  readonly result: CapabilityReviewResult;
}

export interface MentorApiErrorResponse {
  readonly error: string;
  readonly stage?: string;
  readonly updateUrl?: string;
  readonly requestId?: string;
}

export const APP_CLIENT_VERSION_ERROR_STAGE = "app_client_version";

export class AppClientVersionMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AppClientVersionMismatchError";
  }
}

export class MentorRequestError extends Error {
  public constructor(
    message: string,
    public readonly stage?: string,
    public readonly requestId?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MentorRequestError";
  }
}

export function clientVersionFromPackageJson(packageJson: unknown): string {
  if (!isRecord(packageJson)) {
    return "unknown";
  }

  const mentorClientVersion = packageJson.mentorClientVersion;
  if (typeof mentorClientVersion === "string" && mentorClientVersion.trim()) {
    return mentorClientVersion.trim();
  }

  const version = packageJson.version;
  if (typeof version !== "string") {
    return "unknown";
  }

  return version.trim() || "unknown";
}

export function mentorApiErrorUserMessage(status: number, body?: MentorApiErrorResponse): string {
  if (status === 429) {
    return LLM_RATE_LIMIT_MESSAGE;
  }

  if (isAppClientVersionError(status, body)) {
    return formatClientVersionError(body);
  }

  return "応答を生成できませんでした。詳細はログを確認してください。";
}

function isAppClientVersionError(status: number, body: MentorApiErrorResponse | undefined): body is MentorApiErrorResponse {
  return status === 426 && body?.stage === APP_CLIENT_VERSION_ERROR_STAGE;
}

function formatClientVersionError(body: MentorApiErrorResponse): string {
  const message = body.error.trim() || "拡張機能のバージョンがサーバーの要求と一致しません。最新版のVSIXを再インストールしてください。";
  const updateUrl = body.updateUrl?.trim();
  if (updateUrl && !message.includes(updateUrl)) {
    return `${message}\n${updateUrl}`;
  }

  return message;
}

interface AppServerFetchFailureLogInput {
  readonly label: string;
  readonly url: string;
  readonly method: string;
  readonly timeoutMs: number;
  readonly timedOut: boolean;
  readonly error: unknown;
}

interface AppServerFetchTargetLog {
  readonly protocol: string;
  readonly host: string;
  readonly pathname: string;
}

interface AppServerErrorCauseLog {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly errno?: string;
  readonly syscall?: string;
  readonly hostname?: string;
  readonly cause?: AppServerErrorCauseLog;
}

export interface AppServerFetchFailureLog {
  readonly label: string;
  readonly method: string;
  readonly protocol: string;
  readonly host: string;
  readonly pathname: string;
  readonly timeoutMs: number;
  readonly timedOut: boolean;
  readonly error: AppServerErrorCauseLog;
}

export type ServerTokenValidationStatus = "missing" | "valid" | "invalid" | "failed";

export interface ServerTokenValidationResult {
  readonly status: ServerTokenValidationStatus;
  readonly serverUrl: string;
}

export const APP_SERVER_TOKEN_MISSING_MESSAGE = "App Serverトークンが未設定です。Mentor Codeの設定でサーバートークンを登録してください。";

export function describeAppServerFetchFailureForLog(input: AppServerFetchFailureLogInput): AppServerFetchFailureLog {
  const target = describeAppServerFetchTargetForLog(input.url);
  return {
    label: input.label,
    method: input.method,
    ...target,
    timeoutMs: input.timeoutMs,
    timedOut: input.timedOut,
    error: describeErrorForLog(input.error)
  };
}

function describeAppServerFetchTargetForLog(url: string): AppServerFetchTargetLog {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      host: parsed.host,
      pathname: parsed.pathname || "/"
    };
  } catch {
    return {
      protocol: "unparseable",
      host: "unparseable",
      pathname: "unparseable"
    };
  }
}

function describeErrorForLog(error: unknown, depth = 0): AppServerErrorCauseLog {
  const record = isRecord(error) ? error : undefined;
  const name = error instanceof Error ? error.name : optionalString(record, "name");
  const message = error instanceof Error ? error.message : String(error);
  const cause = depth < 4 ? errorCause(error, record) : undefined;

  return {
    ...(name ? { name } : {}),
    message,
    ...optionalLogProperty(record, "code"),
    ...optionalLogProperty(record, "errno"),
    ...optionalLogProperty(record, "syscall"),
    ...optionalLogProperty(record, "hostname"),
    ...(cause === undefined ? {} : { cause: describeErrorForLog(cause, depth + 1) })
  };
}

function errorCause(error: unknown, record: Record<string, unknown> | undefined): unknown {
  if (record && "cause" in record) {
    return record.cause;
  }

  if (error instanceof Error && "cause" in error) {
    return error.cause;
  }

  return undefined;
}

function optionalLogProperty(record: Record<string, unknown> | undefined, key: "code" | "errno" | "syscall" | "hostname"): Partial<AppServerErrorCauseLog> {
  const value = optionalString(record, key);
  return value ? { [key]: value } : {};
}

function optionalString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }

  const value = record[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMentorApiErrorResponse(value: unknown): value is MentorApiErrorResponse {
  return isRecord(value) && typeof value.error === "string";
}

export class ServerClient {
  private static readonly tokenKey = "appServerToken";
  private static readonly healthTimeoutMs = 5_000;
  private static readonly mentorTimeoutMs = 130_000;
  private static readonly mentorIdleTimeoutMs = 30_000;
  private static readonly mentorStreamMaxBytes = 8 * 1024 * 1024;
  private readonly skillSelectionParser = new SkillSelectionParser();

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async setToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: "Mentor Code App Server Token",
      prompt: "MENTOR_SERVER_TOKEN に設定した接続トークンを入力してください。",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length < 16 ? "16文字以上の接続トークンを入力してください。" : undefined
    });

    if (!token) {
      return;
    }

    await this.storeToken(token);
    await vscode.window.showInformationMessage("App Server tokenを保存しました。");
  }

  public async storeToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      await this.clearStoredToken();
      return;
    }

    await this.context.secrets.store(ServerClient.tokenKey, trimmed);
  }

  public async clearToken(): Promise<void> {
    await this.clearStoredToken();
    await this.clearConfiguredToken();
    await vscode.window.showInformationMessage("App Server tokenを削除しました。");
  }

  public async clearStoredToken(): Promise<void> {
    await this.context.secrets.delete(ServerClient.tokenKey);
  }

  public async storedToken(): Promise<string | undefined> {
    const stored = await this.context.secrets.get(ServerClient.tokenKey);
    const trimmed = stored?.trim();
    return trimmed || undefined;
  }

  public async hasToken(): Promise<boolean> {
    return Boolean(await this.currentToken());
  }

  public async currentTokenForSettings(): Promise<string> {
    return await this.currentToken() ?? "";
  }

  public configuredToken(): string | undefined {
    const configured = vscode.workspace
      .getConfiguration("mentorCode")
      .get<string>("serverToken", "");
    const trimmed = configured.trim();
    return trimmed || undefined;
  }

  public async migrateConfiguredTokenToSecretStorage(): Promise<ServerTokenValidationResult | undefined> {
    const configured = this.configuredToken();
    if (!configured) {
      return undefined;
    }

    await this.storeToken(configured);
    await this.clearConfiguredToken();
    return this.validateToken(configured);
  }

  public async validateToken(token?: string): Promise<ServerTokenValidationResult> {
    const serverUrl = this.serverUrl();
    const candidate = token === undefined ? await this.currentToken() : token.trim();
    if (!candidate) {
      return {
        status: "missing",
        serverUrl
      };
    }

    try {
      const response = await this.fetchWithTimeout(
        `${serverUrl}/api/token/verify`,
        {
          method: "POST",
          headers: {
            "X-Mentor-Token": candidate
          }
        },
        ServerClient.healthTimeoutMs,
        "App Server token verification"
      );

      if (response.ok) {
        return {
          status: "valid",
          serverUrl
        };
      }

      return {
        status: response.status === 401 ? "invalid" : "failed",
        serverUrl
      };
    } catch {
      return {
        status: "failed",
        serverUrl
      };
    }
  }

  public async health(): Promise<unknown> {
    const serverUrl = this.serverUrl();
    const response = await this.fetchWithTimeout(
      `${serverUrl}/health`,
      {
        method: "GET"
      },
      ServerClient.healthTimeoutMs,
      "App Server health check"
    );

    if (!response.ok) {
      throw new Error(`App Server health check failed: ${response.status}`);
    }

    return response.json();
  }

  public async supportsCustomInstructionReview(): Promise<boolean> {
    return this.hasCapability(await this.health(), "customInstructionReview");
  }

  public async supportsCapabilityReview(): Promise<boolean> {
    return this.hasCapability(await this.health(), "capabilityReview");
  }

  public async createCapabilityReview(request: CapabilityReviewRequest): Promise<CapabilityReviewResult> {
    const token = await this.currentToken();
    if (!token) {
      throw new Error(APP_SERVER_TOKEN_MISSING_MESSAGE);
    }
    if (!await this.supportsCapabilityReview()) {
      throw new MentorRequestError("接続中のApp ServerではMCP・Skill監査を利用できません。");
    }
    const requestId = createMentorRequestId();
    const response = await this.fetchWithTimeout(
      `${this.serverUrl()}/api/capability-review`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mentor-Token": token,
          "X-Mentor-Client-Version": this.clientVersion(),
          "X-Mentor-Request-Id": requestId
        },
        body: JSON.stringify(request)
      },
      ServerClient.mentorTimeoutMs,
      "App Server capability review"
    );
    if (!response.ok) {
      const errorBody = await this.readJson<unknown>(response);
      const apiError = isMentorApiErrorResponse(errorBody) ? errorBody : undefined;
      throw new MentorRequestError(
        apiError ? this.formatApiError(apiError, response.status) : "MCP・Skill監査を完了できませんでした。",
        apiError?.stage ?? "capability_review",
        apiError?.requestId ?? requestId
      );
    }
    const body = await this.readJson<CapabilityReviewApiResponse>(response);
    if (!isRecord(body) || !isRecord(body.result) ||
      body.result.schemaVersion !== CAPABILITY_REVIEW_RESULT_SCHEMA_VERSION ||
      body.result.revision !== request.revision) {
      throw new MentorRequestError("MCP・Skill監査応答を検証できませんでした。", "capability_review_response", requestId);
    }
    return body.result;
  }

  public async selectSkills(request: SkillSelectionRequest): Promise<SkillSelectionResult> {
    const token = await this.currentToken();
    if (!token) {
      throw new Error(APP_SERVER_TOKEN_MISSING_MESSAGE);
    }
    if (!this.hasCapability(await this.health(), "skillsSelection")) {
      throw new MentorRequestError("接続中のApp ServerではSkillの自動選択を利用できません。");
    }

    const requestId = createMentorRequestId();
    const response = await this.fetchWithTimeout(
      `${this.serverUrl()}/api/skills/select`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mentor-Token": token,
          "X-Mentor-Client-Version": this.clientVersion(),
          "X-Mentor-Request-Id": requestId
        },
        body: JSON.stringify(request)
      },
      ServerClient.mentorTimeoutMs,
      "App Server skill selection"
    );
    if (!response.ok) {
      const errorBody = await this.readJson<unknown>(response);
      const apiError = isMentorApiErrorResponse(errorBody) ? errorBody : undefined;
      throw new MentorRequestError(
        apiError ? this.formatApiError(apiError, response.status) : `App Server request failed: ${response.status}`,
        apiError?.stage ?? "skills_selection",
        apiError?.requestId ?? requestId
      );
    }
    const body = await this.readJson<SkillSelectionApiResponse>(response);
    return this.skillSelectionParser.parse(JSON.stringify(body.result), request.catalog);
  }

  public async createCustomInstructionReview(
    request: CustomInstructionReviewRequest
  ): Promise<CustomInstructionReviewResult> {
    const token = await this.currentToken();
    if (!token) {
      console.error("[Mentor Code Extension] App Server token is missing.");
      throw new Error(APP_SERVER_TOKEN_MISSING_MESSAGE);
    }
    if (!await this.supportsCustomInstructionReview()) {
      throw new MentorRequestError(
        "接続中のApp Serverではカスタム指示のLLMレビューを利用できません。"
      );
    }

    const requestId = createMentorRequestId();
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        `${this.serverUrl()}/api/custom-instruction-review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mentor-Token": token,
            "X-Mentor-Client-Version": this.clientVersion(),
            "X-Mentor-Request-Id": requestId
          },
          body: JSON.stringify(request)
        },
        ServerClient.mentorTimeoutMs,
        "App Server custom instruction review"
      );
    } catch (error) {
      throw new MentorRequestError(
        this.customInstructionReviewFailureMessage("app_server_transport", requestId),
        "app_server_transport",
        requestId,
        { cause: error }
      );
    }

    if (!response.ok) {
      const errorBody = await this.readJson<unknown>(response);
      const apiError = isMentorApiErrorResponse(errorBody) ? errorBody : undefined;
      const apiMessage = apiError
        ? this.formatApiError(apiError, response.status)
        : `App Server request failed: ${response.status}`;
      const stage = apiError?.stage ?? "app_server";
      const responseRequestId = apiError?.requestId ?? requestId;
      if (isAppClientVersionError(response.status, apiError)) {
        throw new AppClientVersionMismatchError(apiMessage);
      }
      const message = response.status === 429
        ? apiMessage
        : "レビューを完了できませんでした。再実行してください。";
      throw new MentorRequestError(
        this.customInstructionReviewFailureMessage(stage, responseRequestId, message),
        stage,
        responseRequestId
      );
    }

    const body = await this.readJson<CustomInstructionReviewApiResponse>(response);
    if (!this.isCustomInstructionReviewApiResponse(body) ||
      body.result.instructionRevision !== request.instructionRevision) {
      throw new MentorRequestError(
        this.customInstructionReviewFailureMessage("custom_instruction_review_response", requestId),
        "custom_instruction_review_response",
        requestId
      );
    }
    return body.result;
  }

  public async createMentorResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    approved: boolean,
    conversationContext?: ConversationContext,
    onProgress?: (event: MentorStreamProgressEvent) => void | Promise<void>,
    customInstruction?: CustomInstructionContext,
    skillContext?: SkillExecutionContext,
    mcpContext?: McpToolContext
  ): Promise<MentorApiResponse> {
    const token = await this.currentToken();
    if (!token) {
      console.error("[Mentor Code Extension] App Server token is missing.");
      throw new Error(APP_SERVER_TOKEN_MISSING_MESSAGE);
    }
    if (customInstruction) {
      await this.requireCustomInstructionCapability();
    }
    if (skillContext && skillContext.activeSkills.length > 0) {
      await this.requireSkillsCapability();
    }
    if (mcpContext && mcpContext.tools.length > 0 &&
      !this.hasCapability(await this.health(), "mcpTools")) {
      throw new MentorRequestError(
        "接続中のApp ServerはMCP Toolsの安全な提案に対応していません。App Serverを更新するか、MCP機能を無効にしてください。"
      );
    }

    const requestId = createMentorRequestId();
    return this.fetchMentorResponse({
      url: `${this.serverUrl()}/api/mentor`,
      token,
      requestId,
      body: JSON.stringify({
        approved,
        request,
        contextPackage,
        ...(conversationContext ? { conversationContext } : {}),
        ...(customInstruction ? { customInstruction } : {}),
        ...(skillContext ? { skillContext } : {}),
        ...(mcpContext ? { mcpContext } : {})
      }),
      ...(onProgress === undefined ? {} : { onProgress })
    });
  }

  private async requireCustomInstructionCapability(): Promise<void> {
    const supported = this.hasCapability(await this.health(), "customInstructionExecution");
    if (!supported) {
      throw new MentorRequestError(
        "接続中のApp Serverはカスタム指示の安全な適用に対応していません。App Serverを更新するか、AGENTS.mdを空にしてください。"
      );
    }
  }

  private async requireSkillsCapability(): Promise<void> {
    const supported = this.hasCapability(await this.health(), "skillsExecution");
    if (!supported) {
      throw new MentorRequestError(
        "接続中のApp ServerはSkillsの安全な適用に対応していません。App Serverを更新するか、Skills機能を無効にしてください。"
      );
    }
  }

  private async fetchMentorResponse(input: {
    readonly url: string;
    readonly token: string;
    readonly requestId: string;
    readonly body: string;
    readonly onProgress?: (event: MentorStreamProgressEvent) => void | Promise<void>;
  }): Promise<MentorApiResponse> {
    const controller = new AbortController();
    let timeoutKind: "hard" | "idle" | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const abortFor = (kind: "hard" | "idle"): void => {
      if (!controller.signal.aborted) {
        timeoutKind = kind;
        controller.abort();
      }
    };
    const hardTimer = setTimeout(() => abortFor("hard"), ServerClient.mentorTimeoutMs);
    const resetIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => abortFor("idle"), ServerClient.mentorIdleTimeoutMs);
    };

    try {
      const response = await fetch(input.url, {
        method: "POST",
        headers: {
          "Accept": "text/event-stream, application/json",
          "Content-Type": "application/json",
          "X-Mentor-Token": input.token,
          "X-Mentor-Client-Version": this.clientVersion(),
          "X-Mentor-Request-Id": input.requestId
        },
        body: input.body,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await this.readJson<MentorApiErrorResponse>(response);
        const message = isMentorApiErrorResponse(errorBody)
          ? this.formatApiError(errorBody, response.status)
          : `App Server request failed: ${response.status}`;
        if (isAppClientVersionError(response.status, errorBody)) {
          throw new AppClientVersionMismatchError(message);
        }
        throw new MentorRequestError(message);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        const body = await this.readJson<MentorApiResponse>(response);
        if (!this.isMentorApiResponse(body)) {
          throw new MentorRequestError(`App Server応答の形式が不正です。requestId: ${input.requestId}`);
        }
        return body;
      }

      resetIdleTimer();
      return await this.consumeMentorStream(
        response,
        input.requestId,
        controller.signal,
        resetIdleTimer,
        input.onProgress
      );
    } catch (error) {
      if (error instanceof AppClientVersionMismatchError) {
        throw error;
      }
      console.error("[Mentor Code Extension] App Server mentor request failed.",
        describeAppServerFetchFailureForLog({
          label: "App Server mentor request",
          url: input.url,
          method: "POST",
          timeoutMs: ServerClient.mentorTimeoutMs,
          timedOut: timeoutKind !== undefined,
          error
        })
      );
      if (timeoutKind === "hard") {
        throw new MentorRequestError(
          `App Serverの応答待ちが130秒を超えたため中止しました。requestId: ${input.requestId}`
        );
      }
      if (timeoutKind === "idle") {
        throw new MentorRequestError(
          `App Serverから30秒間データを受信できなかったため中止しました。requestId: ${input.requestId}`
        );
      }
      if (error instanceof MentorRequestError) {
        throw error;
      }
      throw new MentorRequestError(`${this.genericMentorFailureMessage()} requestId: ${input.requestId}`);
    } finally {
      clearTimeout(hardTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  private async consumeMentorStream(
    response: Response,
    requestId: string,
    signal: AbortSignal,
    onData: () => void,
    onProgress?: (event: MentorStreamProgressEvent) => void | Promise<void>
  ): Promise<MentorApiResponse> {
    if (!response.body) {
      throw new MentorRequestError(`App Serverのストリーム本文がありません。requestId: ${requestId}`);
    }
    const reader = response.body.getReader();
    const abortReader = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abortReader, { once: true });
    const textDecoder = new TextDecoder();
    const eventDecoder = new SseEventDecoder();
    let receivedBytes = 0;
    let lastSequence = 0;

    const handleFrames = async (frames: ReturnType<SseEventDecoder["feed"]>): Promise<MentorApiResponse | undefined> => {
      for (const frame of frames) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          throw new MentorRequestError(`App Serverの進捗イベントが不正です。requestId: ${requestId}`);
        }
        const event = this.readStreamEvent(parsed, requestId, lastSequence);
        lastSequence = event.sequence;
        if (event.type === "progress") {
          if (onProgress) {
            void Promise.resolve().then(() => onProgress(event)).catch((error: unknown) => {
              console.error("[Mentor Code Extension] Mentor progress callback failed.", error);
            });
          }
          continue;
        }
        if (event.type === "error") {
          throw new MentorRequestError(`${event.message} requestId: ${requestId}`);
        }
        return event.result;
      }
      return undefined;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const terminal = await handleFrames([
            ...eventDecoder.feed(textDecoder.decode()),
            ...eventDecoder.finish()
          ]);
          if (terminal) {
            return terminal;
          }
          break;
        }
        receivedBytes += value.byteLength;
        if (receivedBytes > ServerClient.mentorStreamMaxBytes) {
          throw new MentorRequestError(`App Server応答が許容サイズを超えました。requestId: ${requestId}`);
        }
        onData();
        const terminal = await handleFrames(eventDecoder.feed(textDecoder.decode(value, { stream: true })));
        if (terminal) {
          return terminal;
        }
      }
    } finally {
      signal.removeEventListener("abort", abortReader);
      reader.releaseLock();
    }
    throw new MentorRequestError(`App Serverの最終応答を受信できませんでした。requestId: ${requestId}`);
  }

  private readStreamEvent(
    value: unknown,
    requestId: string,
    lastSequence: number
  ): MentorStreamProgressEvent | MentorStreamResultEvent | MentorStreamErrorEvent {
    if (!isRecord(value) || value.requestId !== requestId ||
      typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence <= lastSequence) {
      throw new MentorRequestError(`App Serverの進捗イベント順序が不正です。requestId: ${requestId}`);
    }
    if (value.type === "progress" && typeof value.stage === "string" &&
      typeof value.message === "string" && typeof value.elapsedMs === "number") {
      return value as unknown as MentorStreamProgressEvent;
    }
    if (value.type === "result" && this.isMentorApiResponse(value.result)) {
      return value as unknown as MentorStreamResultEvent;
    }
    if (value.type === "error" && typeof value.status === "number" &&
      typeof value.stage === "string" && typeof value.message === "string") {
      return value as unknown as MentorStreamErrorEvent;
    }
    throw new MentorRequestError(`App Serverの進捗イベント形式が不正です。requestId: ${requestId}`);
  }

  private isMentorApiResponse(value: unknown): value is MentorApiResponse {
    return isRecord(value) && typeof value.safety === "string" && isRecord(value.response) &&
      typeof value.response.title === "string" && Array.isArray(value.response.sections) &&
      Array.isArray(value.response.policyWarnings);
  }

  private isCustomInstructionReviewApiResponse(
    value: unknown
  ): value is CustomInstructionReviewApiResponse {
    return isRecord(value) && isRecord(value.result) &&
      value.result.schemaVersion === CUSTOM_INSTRUCTION_REVIEW_RESULT_SCHEMA_VERSION &&
      typeof value.result.instructionRevision === "string" &&
      isRecord(value.result.review) &&
      value.result.review.schema_version === CUSTOM_INSTRUCTION_REVIEW_SCHEMA_VERSION &&
      typeof value.result.review.summary === "string" &&
      Array.isArray(value.result.review.comments) &&
      value.result.review.comments.every((comment) => typeof comment === "string") &&
      typeof value.result.modelId === "string" &&
      typeof value.result.reviewedAt === "string";
  }

  private hasCapability(
    health: unknown,
    capability: "skillsExecution" | "skillsSelection" | "mcpTools" | "customInstructionExecution" | "customInstructionReview" | "capabilityReview"
  ): boolean {
    return isRecord(health) && isRecord(health.capabilities) &&
      health.capabilities[capability] === true;
  }

  private async currentToken(): Promise<string | undefined> {
    return await this.context.secrets.get(ServerClient.tokenKey) ?? this.configuredToken();
  }

  private async clearConfiguredToken(): Promise<void> {
    await vscode.workspace.getConfiguration("mentorCode").update("serverToken", undefined, vscode.ConfigurationTarget.Global);
  }

  private clientVersion(): string {
    return clientVersionFromPackageJson(this.context.extension.packageJSON);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const method = (init.method ?? "GET").toUpperCase();

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      console.error(
        `[Mentor Code Extension] ${label} ${timedOut ? "timed out" : "failed"} before response.`,
        describeAppServerFetchFailureForLog({
          label,
          url,
          method,
          timeoutMs,
          timedOut,
          error
        })
      );
      throw new Error(this.genericMentorFailureMessage());
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new Error(`App Server response was not valid JSON: ${response.status}`);
    }
  }

  private formatApiError(body: MentorApiErrorResponse, status: number): string {
    console.error("[Mentor Code Extension] Mentor API error detail", {
      stage: this.stageLabel(body.stage),
      requestId: body.requestId,
      error: body.error
    });
    return mentorApiErrorUserMessage(status, body);
  }

  private customInstructionReviewFailureMessage(
    stage: string,
    requestId: string,
    message = "レビューを完了できませんでした。再実行してください。"
  ): string {
    return [
      message,
      `処理段階: ${this.stageLabel(stage)}`,
      `リクエストID: ${requestId}`
    ].join("\n");
  }

  private genericMentorFailureMessage(): string {
    return mentorApiErrorUserMessage(500);
  }

  private stageLabel(stage: string | undefined): string {
    switch (stage) {
      case "external_llm_gemini":
        return "Gemini API（外部LLM）";
      case "external_llm_openai":
        return "OpenAI API（外部LLM）";
      case "server_mechanical_recheck":
        return "App Server機械的再検査";
      case "server_request_recheck":
        return "App Serverリクエスト再検査";
      case "custom_instruction_review_response":
        return "レビュー応答の検証";
      case "custom_instruction_review_request":
        return "レビュー依頼の検証";
      case "custom_instruction_review_unsupported":
        return "レビュー機能の利用可否確認";
      case "custom_instruction_recheck":
        return "カスタム指示の安全性再検査";
      case "app_server_transport":
        return "App Server通信";
      case "app_server_auth":
        return "App Server認証";
      case "app_server_origin":
        return "App Server Origin検証";
      case "app_server_approval":
        return "App Server承認検証";
      case APP_CLIENT_VERSION_ERROR_STAGE:
        return "拡張機能バージョン検証";
      case "app_server":
        return "App Server内部処理";
      default:
        return "App Server";
    }
  }

  private serverUrl(): string {
    const configured = vscode.workspace
      .getConfiguration("mentorCode")
      .get<string>("serverUrl", DEFAULT_APP_SERVER_URL);
    return normalizeAppServerUrl(configured);
  }
}
