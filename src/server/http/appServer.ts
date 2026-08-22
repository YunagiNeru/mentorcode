import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  CustomInstructionGuard,
  isCustomInstructionContext,
  type CustomInstructionContext
} from "../../domain/customInstructions";
import {
  isCustomInstructionReviewRequest,
  type CustomInstructionReviewRequest
} from "../../domain/customInstructionReview";
import type { ContextPackage, ConversationContext, MentorRequest } from "../../domain/types";
import { isCapabilityReviewRequest, type CapabilityReviewRequest } from "../../domain/capabilityReview";
import { isMcpToolContext, type McpToolContext } from "../../domain/mcp";
import {
  SkillExecutionGuard,
  isSkillExecutionContext,
  type SkillExecutionContext
} from "../../domain/skills/skillExecution";
import {
  isSkillSelectionRequest,
  type SkillSelectionRequest
} from "../../domain/skills/skillSelection";
import { createMentorRequestId, isMentorRequestId } from "../../domain/requestId";
import { LLM_RATE_LIMIT_MESSAGE } from "../../domain/llmErrors";
import { PrivacyGuard } from "../../domain/privacy/privacyGuard";
import { MentorRequestGuard } from "../../domain/privacy/mentorRequestGuard";
import type { AppServerConfig } from "../config";
import { ExternalLlmAvailabilityMonitor } from "../llm/externalLlmAvailabilityMonitor";
import { ExternalLlmRequestLimiter } from "../llm/externalLlmRequestLimiter";
import { ExternalLlmError, ExternalLlmHttpError } from "../llm/externalLlmError";
import { CustomInstructionReviewGenerationError } from "../llm/customInstructionReviewGeneration";
import { CustomInstructionReviewResponseError } from "../llm/customInstructionReviewParser";
import type { CustomInstructionReviewResponseEvent } from "../llm/customInstructionReviewTelemetry";
import {
  createExternalLlmExecutionContext,
  externalLlmAvailabilityPolicyFrom,
  type ExternalLlmAttemptEvent
} from "../llm/externalLlmResilience";
import { ModelRouter } from "../llm/modelRouter";
import { ServerSafetyRecheck } from "../security/serverSafetyRecheck";
import { MentorSseStream } from "./mentorSseStream";
import { AppDatabase } from "../persistence/appDatabase";
import { AdminConsole } from "./adminConsole";
import { SecretBox } from "../security/adminCredentials";

const CLIENT_VERSION_HEADER = "x-mentor-client-version";
const REQUEST_ID_HEADER = "x-mentor-request-id";
const CLIENT_VERSION_STAGE = "app_client_version";

interface MentorApiPayload {
  readonly approved: boolean;
  readonly request: MentorRequest;
  readonly contextPackage: ContextPackage;
  readonly conversationContext?: ConversationContext;
  readonly customInstruction?: CustomInstructionContext;
  readonly skillContext?: SkillExecutionContext;
  readonly mcpContext?: McpToolContext;
}

interface VsixCandidate {
  readonly path: string;
  readonly fileName: string;
  readonly mtimeMs: number;
  readonly size: number;
}

class AppServerHttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly stage: string = "app_server",
    public readonly clientMessage?: string
  ) {
    super(message);
  }
}

export class AppServer {
  private readonly router: ModelRouter;
  private readonly safetyRecheck: ServerSafetyRecheck;
  private readonly privacyGuard = new PrivacyGuard();
  private readonly requestGuard = new MentorRequestGuard(this.privacyGuard);
  private readonly customInstructionGuard = new CustomInstructionGuard();
  private readonly skillExecutionGuard = new SkillExecutionGuard();
  private readonly availabilityMonitor = new ExternalLlmAvailabilityMonitor();
  private readonly externalRequestLimiter: ExternalLlmRequestLimiter;
  private server: Server | undefined;
  private readonly database: AppDatabase | undefined;
  private readonly adminConsole: AdminConsole | undefined;

  public constructor(private readonly config: AppServerConfig) {
    if (config.adminEnabled) {
      if (!config.databasePath) throw new Error("MENTOR_DATABASE_PATH is required when administration is enabled.");
      if (!config.settingsMasterKey) throw new Error("MENTOR_SETTINGS_MASTER_KEY is required when administration is enabled.");
      this.database = new AppDatabase(config.databasePath);
      this.database.bootstrap(config.adminBootstrapFile, config.serverToken);
      this.database.purgeAudit(config.auditRetentionDays ?? 90);
      this.adminConsole = new AdminConsole(this.database, config.settingsMasterKey, join(process.cwd(), ".mentor-code", "backups"));
    }
    let routerConfig=config;
    if(this.database&&config.settingsMasterKey&&(config.llmMode==="openai"||config.llmMode==="gemini")){
      const saved=this.database.latestConnection(config.llmMode);
      if(saved){const parsed=JSON.parse(new SecretBox(config.settingsMasterKey).decrypt(saved.encryptedConfig)) as {apiKey?:string};if(parsed.apiKey)routerConfig={...config,...(config.llmMode==="openai"?{openAiApiKey:parsed.apiKey}:{geminiApiKey:parsed.apiKey})};}
    }
    if(routerConfig.llmMode==="openai"&&!routerConfig.openAiApiKey)throw new Error("No OpenAI API key is configured in the environment or administration database.");
    if(routerConfig.llmMode==="gemini"&&!routerConfig.geminiApiKey)throw new Error("No Gemini API key is configured in the environment or administration database.");
    this.router = new ModelRouter(
      routerConfig,
      (event) => this.logAvailabilityEvent(event),
      (event) => this.logReviewResponseEvent(event)
    );
    this.externalRequestLimiter = new ExternalLlmRequestLimiter(config.llmMaxConcurrentRequests);
    this.safetyRecheck = new ServerSafetyRecheck();
  }

  public listen(): Promise<number> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    return new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.port, this.config.host, () => {
        const address = this.server?.address() as AddressInfo;
        resolve(address.port);
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        this.adminConsole?.close(); this.database?.close(); resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        this.adminConsole?.close(); this.database?.close(); resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applySecurityHeaders(request, response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (this.adminConsole && await this.adminConsole.handle(request, response)) return;

    if (request.method === "GET" && request.url === "/health") {
      this.writeJson(response, 200, {
        ok: true,
        service: "mentor-code-app-server",
        capabilities: {
          skillsExecution:
            this.config.skillsExecutionEnabled && this.config.llmMode !== "local",
          skillsSelection:
            this.config.skillsExecutionEnabled && this.config.llmMode !== "local",
          mcpTools:
            this.config.mcpToolsEnabled && this.config.llmMode !== "local",
          customInstructionExecution:
            this.config.customInstructionExecutionEnabled && this.config.llmMode !== "local",
          customInstructionReview:
            this.config.customInstructionReviewEnabled && this.config.llmMode !== "local",
          capabilityReview:
            this.config.capabilityReviewEnabled && this.config.llmMode !== "local"
        }
      });
      return;
    }

    if (request.method === "GET" && request.url === "/internal/availability") {
      this.handleAvailabilityRequest(request, response);
      return;
    }

    if (request.method === "GET" && request.url === "/downloads/latest") {
      this.handleVsixDownload(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/token/verify") {
      this.handleTokenVerifyRequest(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/custom-instruction-review") {
      const requestId = this.requestId(request);
      response.setHeader("X-Mentor-Request-Id", requestId);
      const requestController = new AbortController();
      const abortRequest = (): void => {
        if (!response.writableEnded) {
          requestController.abort();
        }
      };
      request.once("aborted", abortRequest);
      response.once("close", abortRequest);
      try {
        await this.handleCustomInstructionReviewRequest(
          request,
          response,
          requestId,
          requestController.signal
        );
      } catch (error) {
        const mapped = this.mapError(error);
        this.logError(mapped.stage, error, requestId);
        if (!response.destroyed && !response.writableEnded) {
          this.writeJson(response, mapped.status, {
            error: mapped.clientMessage ?? this.clientErrorMessage(mapped.stage),
            stage: mapped.stage,
            requestId
          });
        }
      } finally {
        request.removeListener("aborted", abortRequest);
        response.removeListener("close", abortRequest);
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/capability-review") {
      const requestId = this.requestId(request);
      response.setHeader("X-Mentor-Request-Id", requestId);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      request.once("aborted", abort);
      response.once("close", abort);
      try {
        await this.handleCapabilityReviewRequest(request, response, requestId, controller.signal);
      } catch (error) {
        const mapped = this.mapError(error);
        this.logError(mapped.stage, error, requestId);
        if (!response.destroyed && !response.writableEnded) {
          this.writeJson(response, mapped.status, {
            error: mapped.clientMessage ?? this.clientErrorMessage(mapped.stage),
            stage: mapped.stage,
            requestId
          });
        }
      } finally {
        request.removeListener("aborted", abort);
        response.removeListener("close", abort);
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/skills/select") {
      const requestId = this.requestId(request);
      response.setHeader("X-Mentor-Request-Id", requestId);
      const requestController = new AbortController();
      const abortRequest = (): void => {
        if (!response.writableEnded) {
          requestController.abort();
        }
      };
      request.once("aborted", abortRequest);
      response.once("close", abortRequest);
      try {
        await this.handleSkillSelectionRequest(
          request,
          response,
          requestId,
          requestController.signal
        );
      } catch (error) {
        const mapped = this.mapError(error);
        this.logError(mapped.stage, error, requestId);
        if (!response.destroyed && !response.writableEnded) {
          this.writeJson(response, mapped.status, {
            error: mapped.clientMessage ?? this.clientErrorMessage(mapped.stage),
            stage: mapped.stage,
            requestId
          });
        }
      } finally {
        request.removeListener("aborted", abortRequest);
        response.removeListener("close", abortRequest);
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/mentor") {
      const requestId = this.requestId(request);
      response.setHeader("X-Mentor-Request-Id", requestId);
      const requestController = new AbortController();
      const mentorStream = this.wantsMentorStream(request)
        ? new MentorSseStream(response, requestId)
        : undefined;
      const abortRequest = (): void => {
        if (!response.writableEnded) {
          requestController.abort();
        }
      };
      request.once("aborted", abortRequest);
      response.once("close", abortRequest);
      try {
        await this.handleMentorRequest(
          request,
          response,
          requestId,
          requestController.signal,
          mentorStream
        );
      } catch (error) {
        const mapped = this.mapError(error);
        this.logError(mapped.stage, error, requestId);
        if (mentorStream?.isStarted()) {
          mentorStream.fail(
            mapped.status,
            mapped.stage,
            mapped.clientMessage ?? this.clientErrorMessage(mapped.stage)
          );
        } else if (!response.destroyed && !response.writableEnded) {
          this.writeJson(response, mapped.status, {
            error: mapped.clientMessage ?? this.clientErrorMessage(mapped.stage),
            stage: mapped.stage,
            requestId
          });
        }
      } finally {
        request.removeListener("aborted", abortRequest);
        response.removeListener("close", abortRequest);
      }
      return;
    }

    this.writeJson(response, 404, {
      error: "Not found"
    });
  }

  private handleVsixDownload(response: ServerResponse): void {
    const candidate = this.latestVsixCandidate();
    if (!candidate) {
      this.writeJson(response, 404, {
        error: "VSIX download is not available."
      });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${this.downloadFileName(candidate.fileName)}"`,
      "Content-Length": String(candidate.size)
    });
    const stream = createReadStream(candidate.path);
    stream.on("error", (error) => {
      this.logError("app_server_download", error);
      response.destroy(error);
    });
    stream.pipe(response);
  }

  private latestVsixCandidate(): VsixCandidate | undefined {
    const directory = this.config.vsixDownloadDir ?? join(process.cwd(), "downloads");
    let fileNames: string[];
    try {
      const stat = statSync(directory);
      if (!stat.isDirectory()) {
        return undefined;
      }
      fileNames = readdirSync(directory);
    } catch {
      return undefined;
    }

    return fileNames
      .filter((fileName) => fileName.toLowerCase().endsWith(".vsix"))
      .map((fileName) => this.vsixCandidate(directory, fileName))
      .filter((candidate): candidate is VsixCandidate => candidate !== undefined)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName))
      .at(0);
  }

  private vsixCandidate(directory: string, fileName: string): VsixCandidate | undefined {
    const path = join(directory, fileName);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) {
        return undefined;
      }

      return {
        path,
        fileName,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      };
    } catch {
      return undefined;
    }
  }

  private downloadFileName(fileName: string): string {
    return fileName.replace(/["\r\n]/g, "_");
  }

  private handleTokenVerifyRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!this.isOriginAllowed(request.headers.origin)) {
      this.writeJson(response, 403, {
        ok: false,
        error: "Origin is not allowed.",
        stage: "app_server_origin"
      });
      return;
    }

    if (!this.isValidToken(request)) {
      this.writeJson(response, 401, {
        ok: false,
        error: "App server token is missing or invalid.",
        stage: "app_server_auth"
      });
      return;
    }

    this.writeJson(response, 200, {
      ok: true,
      service: "mentor-code-app-server"
    });
  }

  private async handleMentorRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    signal: AbortSignal,
    mentorStream?: MentorSseStream
  ): Promise<void> {
    if (!this.isOriginAllowed(request.headers.origin)) {
      this.writeLoggedError(response, 403, "app_server_origin", "Origin is not allowed.");
      return;
    }

    if (!this.isValidToken(request)) {
      this.writeLoggedError(response, 401, "app_server_auth", "App server token is missing or invalid.");
      return;
    }

    if (!this.verifyClientVersion(request, response)) {
      return;
    }

    const payload = await this.readJson<MentorApiPayload>(request);
    this.assertMentorApiPayload(payload);
    if (
      payload.customInstruction &&
      (!this.config.customInstructionExecutionEnabled || this.config.llmMode === "local")
    ) {
      throw new AppServerHttpError(
        409,
        "Custom instructions require an external LLM mode.",
        "custom_instruction_unsupported"
      );
    }
    if (
      payload.skillContext &&
      (!this.config.skillsExecutionEnabled || this.config.llmMode === "local")
    ) {
      throw new AppServerHttpError(
        409,
        "Skills require an external LLM mode and enabled server support.",
        "skills_execution_unsupported"
      );
    }
    if (payload.mcpContext && (!this.config.mcpToolsEnabled || this.config.llmMode === "local")) {
      throw new AppServerHttpError(
        409,
        "MCP Tools require an external LLM mode and enabled server support.",
        "mcp_tools_unsupported"
      );
    }

    if (!payload.approved) {
      this.writeLoggedError(response, 409, "app_server_approval", "Masked context must be approved before mentor API use.");
      return;
    }

    const recheck = await this.safetyRecheck.verify(payload.contextPackage);
    if (!recheck.accepted) {
      this.writeLoggedError(response, 422, "server_mechanical_recheck", recheck.reason);
      return;
    }

    const requestDecision = await this.requestGuard.sanitize(payload.request);
    if (!requestDecision.accepted) {
      this.writeLoggedError(response, 422, "server_request_recheck", requestDecision.reason);
      return;
    }
    if (payload.customInstruction) {
      const customInstructionDecision = this.customInstructionGuard.inspect(payload.customInstruction.content);
      if (!customInstructionDecision.accepted) {
        this.writeLoggedError(response, 422, "custom_instruction_recheck", customInstructionDecision.reason);
        return;
      }
    }
    if (payload.skillContext) {
      const skillDecision = this.skillExecutionGuard.inspect(payload.skillContext);
      if (!skillDecision.accepted) {
        this.writeLoggedError(response, 422, "skills_execution_recheck", skillDecision.reason);
        return;
      }
    }
    if (payload.mcpContext) {
      this.assertSafeMcpContext(payload.mcpContext);
    }

    mentorStream?.start();
    mentorStream?.progress({ stage: "request_accepted" });
    mentorStream?.progress({ stage: "context_validated" });

    console.log("[Mentor Code App Server] mentor request accepted", {
      includedFiles: payload.contextPackage.files.length,
      blockedFiles: payload.contextPackage.blockedFiles.length,
      explicitReferences: payload.contextPackage.files.filter(
        (file) => file.contextSource === "explicit_reference"
      ).length,
      incompleteContextFiles: payload.contextPackage.files.filter(
        (file) => file.contentComplete === false
      ).length,
      hasConversationContext: Boolean(payload.conversationContext),
      hasCustomInstruction: Boolean(payload.customInstruction),
      customInstructionBytes: payload.customInstruction?.byteLength ?? 0,
      activeSkillCount: payload.skillContext?.activeSkills.length ?? 0,
      activeSkillBytes: payload.skillContext?.activeSkills.reduce((total, skill) => total + skill.byteLength, 0) ?? 0,
      mcpToolCount: payload.mcpContext?.tools.length ?? 0,
      recentMessages: payload.conversationContext?.recentMessages.length ?? 0,
      hasCommandResult: Boolean(payload.conversationContext?.lastCommandResult)
    });

    const release = this.config.llmMode === "local"
      ? () => undefined
      : this.externalRequestLimiter.tryAcquire();
    if (!release) {
      throw new AppServerHttpError(
        503,
        "External LLM request capacity is exhausted.",
        "external_llm_capacity"
      );
    }

    let mentorResponse;
    try {
      mentorResponse = await this.router.createMentorResponse(
        requestDecision.request,
        payload.contextPackage,
        payload.conversationContext,
        createExternalLlmExecutionContext(
          externalLlmAvailabilityPolicyFrom(this.config),
          requestId,
          signal,
          Date.now,
          mentorStream === undefined ? undefined : (update) => mentorStream.progress(update)
        ),
        payload.customInstruction,
        payload.skillContext?.activeSkills,
        payload.mcpContext
      );
    } finally {
      release();
    }
    const result = {
      response: mentorResponse,
      safety: recheck.reason
    };
    if (mentorStream) {
      mentorStream.complete(result);
    } else {
      this.writeJson(response, 200, result);
    }
  }

  private async handleCustomInstructionReviewRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.isOriginAllowed(request.headers.origin)) {
      throw new AppServerHttpError(403, "Origin is not allowed.", "app_server_origin");
    }

    if (!this.isValidToken(request)) {
      throw new AppServerHttpError(
        401,
        "App server token is missing or invalid.",
        "app_server_auth"
      );
    }

    if (!this.verifyClientVersion(request, response)) {
      return;
    }

    if (!this.config.customInstructionReviewEnabled || this.config.llmMode === "local") {
      throw new AppServerHttpError(
        409,
        "Custom instruction review requires an enabled external LLM mode.",
        "custom_instruction_review_unsupported"
      );
    }

    const payload = await this.readJson<CustomInstructionReviewRequest>(request);
    if (
      !isCustomInstructionReviewRequest(payload) ||
      !isCustomInstructionContext(payload.customInstruction)
    ) {
      throw new AppServerHttpError(
        400,
        "Custom instruction review body is malformed.",
        "custom_instruction_review_request"
      );
    }

    const customInstructionDecision = this.customInstructionGuard.inspect(
      payload.customInstruction.content
    );
    if (!customInstructionDecision.accepted) {
      throw new AppServerHttpError(
        422,
        customInstructionDecision.reason,
        "custom_instruction_recheck"
      );
    }

    const release = this.externalRequestLimiter.tryAcquire();
    if (!release) {
      throw new AppServerHttpError(
        503,
        "External LLM request capacity is exhausted.",
        "external_llm_capacity"
      );
    }

    console.log("[Mentor Code App Server] custom instruction review accepted", {
      requestId,
      instructionRevision: payload.instructionRevision,
      customInstructionBytes: payload.customInstruction.byteLength
    });

    try {
      const result = await this.router.createCustomInstructionReview(
        payload,
        createExternalLlmExecutionContext(
          externalLlmAvailabilityPolicyFrom(this.config),
          requestId,
          signal,
          Date.now
        )
      );
      this.writeJson(response, 200, { result });
    } finally {
      release();
    }
  }

  private async handleCapabilityReviewRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.isOriginAllowed(request.headers.origin)) {
      throw new AppServerHttpError(403, "Origin is not allowed.", "app_server_origin");
    }
    if (!this.isValidToken(request)) {
      throw new AppServerHttpError(401, "App server token is missing or invalid.", "app_server_auth");
    }
    if (!this.verifyClientVersion(request, response)) {
      return;
    }
    if (!this.config.capabilityReviewEnabled || this.config.llmMode === "local") {
      throw new AppServerHttpError(409, "Capability review requires an enabled external LLM mode.", "capability_review_unsupported");
    }
    const payload = await this.readJson<CapabilityReviewRequest>(request);
    if (!isCapabilityReviewRequest(payload)) {
      throw new AppServerHttpError(400, "Capability review body is malformed.", "capability_review_request");
    }
    const inspected = this.privacyGuard.analyzeFile({
      path: `capability-review/${payload.kind}/${payload.identifier}.txt`,
      content: payload.content
    });
    if (inspected.blocked || inspected.excluded || inspected.maskedContent === undefined ||
      inspected.findings.some((finding) => finding.action === "mask" || finding.action === "block")) {
      throw new AppServerHttpError(422, "Capability review content failed the server safety recheck.", "capability_review_recheck");
    }
    const release = this.externalRequestLimiter.tryAcquire();
    if (!release) {
      throw new AppServerHttpError(503, "External LLM request capacity is exhausted.", "external_llm_capacity");
    }
    try {
      const result = await this.router.createCapabilityReview(
        payload,
        createExternalLlmExecutionContext(
          externalLlmAvailabilityPolicyFrom(this.config),
          requestId,
          signal,
          Date.now
        )
      );
      this.writeJson(response, 200, { result });
    } finally {
      release();
    }
  }

  private async handleSkillSelectionRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.isOriginAllowed(request.headers.origin)) {
      throw new AppServerHttpError(403, "Origin is not allowed.", "app_server_origin");
    }
    if (!this.isValidToken(request)) {
      throw new AppServerHttpError(401, "App server token is missing or invalid.", "app_server_auth");
    }
    if (!this.verifyClientVersion(request, response)) {
      return;
    }
    if (!this.config.skillsExecutionEnabled || this.config.llmMode === "local") {
      throw new AppServerHttpError(
        409,
        "Skill selection requires an enabled external LLM mode.",
        "skills_selection_unsupported"
      );
    }

    const payload = await this.readJson<unknown>(request);
    if (!isSkillSelectionRequest(payload)) {
      throw new AppServerHttpError(400, "Skill selection body is malformed.", "skills_selection_request");
    }
    const taskDecision = await this.requestGuard.sanitize({ task: payload.task });
    if (!taskDecision.accepted) {
      throw new AppServerHttpError(422, taskDecision.reason, "server_request_recheck");
    }
    this.assertSafeSkillCatalog(payload);

    const release = this.externalRequestLimiter.tryAcquire();
    if (!release) {
      throw new AppServerHttpError(
        503,
        "External LLM request capacity is exhausted.",
        "external_llm_capacity"
      );
    }

    console.log("[Mentor Code App Server] skill selection accepted", {
      requestId,
      candidateCount: payload.catalog.length
    });
    try {
      const result = await this.router.selectSkills(
        { task: taskDecision.request.task, catalog: payload.catalog },
        createExternalLlmExecutionContext(
          externalLlmAvailabilityPolicyFrom(this.config),
          requestId,
          signal,
          Date.now
        )
      );
      this.writeJson(response, 200, { result });
    } finally {
      release();
    }
  }

  private assertSafeSkillCatalog(payload: SkillSelectionRequest): void {
    for (const entry of payload.catalog) {
      const result = this.privacyGuard.analyzeFile({
        path: `agent-skills/${entry.name}/description.txt`,
        content: entry.description
      });
      if (result.blocked || result.excluded || result.maskedContent === undefined ||
        result.findings.some((finding) => finding.action === "mask" || finding.action === "block")) {
        throw new AppServerHttpError(
          422,
          "Skill候補の再検査で未処理の秘密情報候補を検出しました。",
          "skills_selection_recheck"
        );
      }
    }
  }

  private wantsMentorStream(request: IncomingMessage): boolean {
    if (!this.config.mentorStreamingEnabled) {
      return false;
    }
    const accept = this.headerValue(request.headers.accept)?.toLowerCase() ?? "";
    return accept.split(",").some((value) => value.trim().startsWith("text/event-stream"));
  }

  private assertMentorApiPayload(payload: MentorApiPayload): void {
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.approved !== "boolean" ||
      typeof payload.request !== "object" ||
      payload.request === null ||
      typeof payload.contextPackage !== "object" ||
      payload.contextPackage === null ||
      !Array.isArray(payload.contextPackage.files)
    ) {
      throw new AppServerHttpError(400, "Mentor request body is malformed.");
    }
    if (payload.customInstruction !== undefined && !isCustomInstructionContext(payload.customInstruction)) {
      throw new AppServerHttpError(400, "Custom instruction body is malformed.");
    }
    if (payload.skillContext !== undefined && !isSkillExecutionContext(payload.skillContext)) {
      throw new AppServerHttpError(400, "Skill execution body is malformed.");
    }
    if (payload.mcpContext !== undefined && !isMcpToolContext(payload.mcpContext)) {
      throw new AppServerHttpError(400, "MCP tool context is malformed.");
    }
  }

  private assertSafeMcpContext(context: McpToolContext): void {
    for (const tool of context.tools) {
      const content = JSON.stringify({
        description: tool.description ?? "",
        inputSchema: tool.inputSchema
      });
      const result = this.privacyGuard.analyzeFile({
        path: `mcp/${tool.serverId}/${tool.name}.json`,
        content,
        sizeBytes: Buffer.byteLength(content, "utf8")
      });
      if (result.blocked || result.excluded || result.maskedContent === undefined ||
        result.findings.some((finding) => finding.action === "mask" || finding.action === "block")) {
        throw new AppServerHttpError(
          422,
          "MCP Toolカタログの再検査で未処理の秘密情報候補を検出しました。",
          "mcp_tools_recheck"
        );
      }
    }
  }

  private verifyClientVersion(request: IncomingMessage, response: ServerResponse): boolean {
    const requiredClientVersion = this.config.requiredClientVersion?.trim();
    if (!requiredClientVersion) {
      return true;
    }

    const clientVersion = this.headerValue(request.headers[CLIENT_VERSION_HEADER]);
    if (clientVersion === requiredClientVersion) {
      return true;
    }

    this.logError(
      CLIENT_VERSION_STAGE,
      `Client version mismatch. required=${requiredClientVersion}; actual=${clientVersion ?? "missing"}`
    );
    this.writeJson(response, 426, {
      error: this.clientVersionErrorMessage(),
      stage: CLIENT_VERSION_STAGE,
      updateUrl: this.config.clientUpdateUrl
    });
    return false;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value.at(0) : value;
    const trimmed = raw?.trim();
    return trimmed || undefined;
  }

  private clientVersionErrorMessage(): string {
    return `拡張機能のバージョンがサーバーの要求と一致しません。最新版のVSIXをダウンロードして再インストールしてください: ${this.config.clientUpdateUrl}`;
  }

  private mapError(error: unknown): AppServerHttpError {
    if (error instanceof AppServerHttpError) {
      return error;
    }

    if (error instanceof ExternalLlmHttpError) {
      const stage = this.externalLlmStage(error.provider);
      if (error.status === 429) {
        return new AppServerHttpError(429, error.message, stage, LLM_RATE_LIMIT_MESSAGE);
      }
      if (error.status === 503 || error.status === 504) {
        return new AppServerHttpError(error.status, error.message, stage);
      }
      return new AppServerHttpError(502, error.message, stage);
    }

    if (error instanceof ExternalLlmError) {
      const stage = this.externalLlmStage(error.provider);
      if (error.details.kind === "timeout" || error.details.kind === "deadline_exceeded") {
        return new AppServerHttpError(504, error.message, stage);
      }
      if (error.details.kind === "circuit_open") {
        return new AppServerHttpError(503, error.message, stage);
      }
      if (error.details.kind === "cancelled") {
        return new AppServerHttpError(499, error.message, stage);
      }
      return new AppServerHttpError(502, error.message, stage);
    }

    if (error instanceof CustomInstructionReviewGenerationError) {
      return new AppServerHttpError(
        502,
        error.message,
        "custom_instruction_review_response",
        this.customInstructionReviewGenerationClientMessage(error)
      );
    }

    if (error instanceof CustomInstructionReviewResponseError) {
      return new AppServerHttpError(
        502,
        error.message,
        "custom_instruction_review_response",
        "LLMレビューの形式を確認できませんでした。再実行してください。"
      );
    }

    if (error instanceof Error && error.message.startsWith("OpenAI ")) {
      return new AppServerHttpError(502, error.message, "external_llm_openai");
    }

    if (error instanceof Error && error.message.startsWith("Gemini ")) {
      return new AppServerHttpError(502, error.message, "external_llm_gemini");
    }

    return new AppServerHttpError(500, "App Server request failed.", "app_server");
  }

  private customInstructionReviewGenerationClientMessage(
    error: CustomInstructionReviewGenerationError
  ): string {
    if (error.code === "max_tokens") {
      return "LLMレビュー応答が途中で終了しました。時間を置いて再実行してください。";
    }
    if (error.code === "prompt_blocked" || error.code === "candidate_blocked") {
      return "安全性判定によりLLMレビューを完了できませんでした。カスタム指示の内容を確認してください。";
    }
    return "LLMレビュー応答を取得できませんでした。再実行してください。";
  }

  private externalLlmStage(provider: ExternalLlmHttpError["provider"]): string {
    return provider === "gemini" ? "external_llm_gemini" : "external_llm_openai";
  }

  private writeLoggedError(response: ServerResponse, status: number, stage: string, detail: string): void {
    this.logError(stage, detail);
    this.writeJson(response, status, {
      error: this.clientErrorMessage(stage),
      stage
    });
  }

  private clientErrorMessage(stage: string): string {
    if (stage === CLIENT_VERSION_STAGE) {
      return this.clientVersionErrorMessage();
    }

    if (stage === "external_llm_openai" || stage === "external_llm_gemini" || stage === "external_llm_capacity") {
      return "LLM応答を生成できませんでした。詳細はApp Serverログを確認してください。";
    }

    return "リクエストを処理できませんでした。詳細はApp Serverログを確認してください。";
  }

  private logError(stage: string, error: unknown, requestId?: string): void {
    const detail = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    const externalDetails = error instanceof ExternalLlmError
      ? `\n${JSON.stringify({
        provider: error.provider,
        ...error.details
      })}`
      : "";
    const entry = this.sanitizeLogEntry([
      `[${new Date().toISOString()}] [Mentor Code App Server] stage=${stage}${requestId ? ` requestId=${requestId}` : ""}`,
      `${detail}${externalDetails}`
    ].join("\n"));

    console.error(entry);
    this.appendLog(entry);
  }

  private handleAvailabilityRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!this.isOriginAllowed(request.headers.origin)) {
      this.writeJson(response, 403, {
        ok: false,
        error: "Origin is not allowed."
      });
      return;
    }

    if (!this.isValidToken(request)) {
      this.writeJson(response, 401, {
        ok: false,
        error: "App server token is missing or invalid."
      });
      return;
    }

    this.writeJson(response, 200, {
      ok: true,
      ...this.availabilityMonitor.snapshot(this.router.circuitSnapshots())
    });
  }

  private logAvailabilityEvent(event: ExternalLlmAttemptEvent): void {
    this.availabilityMonitor.record(event);
    const entry = this.sanitizeLogEntry(JSON.stringify({
      at: new Date().toISOString(),
      ...event
    }));
    console.log(entry);
    this.appendLog(entry);
  }

  private logReviewResponseEvent(event: CustomInstructionReviewResponseEvent): void {
    const entry = this.sanitizeLogEntry(JSON.stringify({
      at: new Date().toISOString(),
      ...event
    }));
    console.log(entry);
    this.appendLog(entry);
  }

  private requestId(request: IncomingMessage): string {
    const candidate = this.headerValue(request.headers[REQUEST_ID_HEADER]);
    if (candidate && isMentorRequestId(candidate)) {
      return candidate;
    }

    return createMentorRequestId();
  }

  private sanitizeLogEntry(entry: string): string {
    const result = this.privacyGuard.analyzeFile({
      path: "logs/app-server-error.txt",
      content: entry,
      sizeBytes: new TextEncoder().encode(entry).byteLength
    });

    if (result.blocked || result.excluded || result.maskedContent === undefined) {
      return "[Mentor Code App Server] Error detail was blocked by Privacy Guard before logging.";
    }

    return result.maskedContent;
  }

  private appendLog(entry: string): void {
    if (!this.config.logFilePath) {
      return;
    }

    try {
      mkdirSync(dirname(this.config.logFilePath), { recursive: true });
      appendFileSync(this.config.logFilePath, `${entry}\n\n`, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Mentor Code App Server] Failed to write app server log: ${detail}`);
    }
  }

  private isValidToken(request: IncomingMessage): boolean {
    const token = request.headers["x-mentor-token"];
    if (typeof token !== "string" || token.length === 0) return false;
    return this.database ? this.database.verifyUserToken(token) : token === this.config.serverToken;
  }

  private applySecurityHeaders(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (this.isOriginAllowed(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin ?? "http://127.0.0.1");
      response.setHeader("Vary", "Origin");
    }

    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Mentor-Token,X-Mentor-Client-Version,X-Mentor-Request-Id");
    response.setHeader("Access-Control-Expose-Headers", "X-Mentor-Request-Id");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }

    return this.config.allowedOrigins.some((allowed) => {
      if (allowed.endsWith("://")) {
        return origin.startsWith(allowed);
      }

      return origin === allowed;
    });
  }

  private readJson<T>(request: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      request.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 1_000_000) {
          reject(new AppServerHttpError(413, "Request body is too large."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });

      request.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
        } catch {
          reject(new AppServerHttpError(400, "Request body must be valid JSON."));
        }
      });

      request.on("error", reject);
    });
  }

  private writeJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify(body));
  }
}
