import { MentorEngine } from "../../domain/mentor/mentorEngine";
import { ImplementationRequirementResolver, type ImplementationRequirement } from "../../domain/mentor/implementationRequirement";
import { ReferenceContextGuard } from "../../domain/mentor/referenceContextGuard";
import type { CustomInstructionContext } from "../../domain/customInstructions";
import type { CustomInstructionReviewRequest, CustomInstructionReviewResult } from "../../domain/customInstructionReview";
import type { ContextPackage, ConversationContext, MentorRequest, MentorResponse } from "../../domain/types";
import type { SkillActivationContext } from "../../domain/skills/skillContext";
import type { SkillSelectionRequest, SkillSelectionResult } from "../../domain/skills/skillSelection";
import type { McpToolContext } from "../../domain/mcp";
import type { CapabilityReviewRequest, CapabilityReviewResult } from "../../domain/capabilityReview";
import type { AppServerConfig } from "../config";
import type { ExternalLlmCircuitSnapshot } from "./externalLlmCircuitBreaker";
import { ExternalLlmError, ExternalLlmHttpError } from "./externalLlmError";
import { GeminiClient } from "./geminiClient";
import { OpenAiClient } from "./openAiClient";
import { CustomInstructionReviewClient } from "./customInstructionReviewClient";
import type { CustomInstructionReviewResponseTelemetry } from "./customInstructionReviewTelemetry";
import { SkillSelectionClient } from "./skillSelectionClient";
import { CapabilityReviewClient } from "./capabilityReviewClient";
import type { GeminiThinkingOptions } from "./reasoning";
import {
  type ExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor,
  externalLlmAvailabilityPolicyFrom,
  type ExternalLlmTelemetry
} from "./externalLlmResilience";

export class ModelRouter {
  private readonly localEngine = new MentorEngine();
  private readonly implementationRequirements = new ImplementationRequirementResolver();
  private readonly referenceContextGuard = new ReferenceContextGuard();

  private readonly resilienceExecutor: ExternalLlmResilienceExecutor;

  public constructor(
    private readonly config: AppServerConfig,
    telemetry?: ExternalLlmTelemetry,
    private readonly reviewResponseTelemetry?: CustomInstructionReviewResponseTelemetry
  ) {
    this.resilienceExecutor = new ExternalLlmResilienceExecutor(
      externalLlmAvailabilityPolicyFrom(config),
      telemetry ? { telemetry } : {}
    );
  }

  public async createMentorResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext: ConversationContext | undefined,
    executionContext: ExternalLlmExecutionContext,
    customInstruction?: CustomInstructionContext,
    activeSkills?: readonly SkillActivationContext[],
    mcpContext?: McpToolContext
  ): Promise<MentorResponse> {
    const contextIssues = this.referenceContextGuard.inspect(request, contextPackage);
    if (contextIssues.length > 0) {
      return this.referenceContextGuard.rejectionResponse(contextIssues);
    }

    if (this.config.llmMode === "openai") {
      return this.createOpenAiResponse(
        request,
        contextPackage,
        conversationContext,
        executionContext,
        customInstruction,
        activeSkills,
        mcpContext
      );
    }

    if (this.config.llmMode === "gemini") {
      return this.createGeminiResponse(
        request,
        contextPackage,
        conversationContext,
        executionContext,
        customInstruction,
        activeSkills,
        mcpContext
      );
    }

    return this.createLocalResponse({
      ...request,
      guardSummary: contextPackage.summary
    });
  }

  private createLocalResponse(request: MentorRequest): MentorResponse {
    const response = this.localEngine.respond(request);
    const requirement = this.implementationRequirements.resolve(request);
    if (!requirement.requiresPatch) {
      return response;
    }

    return this.localImplementationFailureResponse(response, requirement);
  }

  private async createOpenAiResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext: ConversationContext | undefined,
    executionContext: ExternalLlmExecutionContext,
    customInstruction?: CustomInstructionContext,
    activeSkills?: readonly SkillActivationContext[],
    mcpContext?: McpToolContext
  ): Promise<MentorResponse> {
    if (!this.config.openAiApiKey) {
      throw new Error("OpenAI API key is not configured.");
    }

    const client = new OpenAiClient({
      apiKey: this.config.openAiApiKey,
      model: this.config.openAiModel,
      ...(this.config.openAiReasoningEffort === undefined
        ? {}
        : { reasoningEffort: this.config.openAiReasoningEffort }),
      resilienceExecutor: this.resilienceExecutor,
      executionContext
    });

    return client.createMentorResponse(request, contextPackage, conversationContext, customInstruction, activeSkills, mcpContext);
  }

  private async createGeminiResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext: ConversationContext | undefined,
    executionContext: ExternalLlmExecutionContext,
    customInstruction?: CustomInstructionContext,
    activeSkills?: readonly SkillActivationContext[],
    mcpContext?: McpToolContext
  ): Promise<MentorResponse> {
    if (!this.config.geminiApiKey) {
      throw new Error("Gemini API key is not configured.");
    }

    const primaryClient = new GeminiClient({
      apiKey: this.config.geminiApiKey,
      model: this.config.geminiModel,
      thinking: this.geminiThinkingOptions(false),
      resilienceExecutor: this.resilienceExecutor,
      executionContext
    });

    try {
      return await primaryClient.createMentorResponse(
        request,
        contextPackage,
        conversationContext,
        customInstruction,
        activeSkills,
        mcpContext
      );
    } catch (error) {
      const fallbackModel = this.fallbackGeminiModel(error, executionContext);
      if (!fallbackModel) {
        throw error;
      }

      executionContext.progress?.({ stage: "fallback_started" });

      const fallbackClient = new GeminiClient({
        apiKey: this.config.geminiApiKey,
        model: fallbackModel,
        thinking: this.geminiThinkingOptions(true),
        resilienceExecutor: this.resilienceExecutor,
        executionContext
      });
      return fallbackClient.createMentorResponse(
        request,
        contextPackage,
        conversationContext,
        customInstruction,
        activeSkills,
        mcpContext
      );
    }
  }

  public circuitSnapshots(): readonly ExternalLlmCircuitSnapshot[] {
    return this.resilienceExecutor.circuitSnapshots();
  }

  public async selectSkills(
    request: SkillSelectionRequest,
    executionContext: ExternalLlmExecutionContext
  ): Promise<SkillSelectionResult> {
    if (this.config.llmMode === "openai") {
      if (!this.config.openAiApiKey) {
        throw new Error("OpenAI API key is not configured.");
      }
      return this.skillSelector(
        "openai",
        this.config.openAiApiKey,
        this.config.openAiModel,
        executionContext
      ).select(request);
    }

    if (this.config.llmMode === "gemini") {
      if (!this.config.geminiApiKey) {
        throw new Error("Gemini API key is not configured.");
      }
      try {
        return await this.skillSelector(
          "gemini",
          this.config.geminiApiKey,
          this.config.geminiModel,
          executionContext
        ).select(request);
      } catch (error) {
        const fallbackModel = this.fallbackGeminiModel(error, executionContext);
        if (!fallbackModel) {
          throw error;
        }
        executionContext.progress?.({ stage: "fallback_started" });
        return this.skillSelector(
          "gemini",
          this.config.geminiApiKey,
          fallbackModel,
          executionContext
        ).select(request);
      }
    }

    throw new Error("Skill selection is unavailable in local mode.");
  }

  public async createCustomInstructionReview(
    request: CustomInstructionReviewRequest,
    executionContext: ExternalLlmExecutionContext
  ): Promise<CustomInstructionReviewResult> {
    if (this.config.llmMode === "openai") {
      if (!this.config.openAiApiKey) {
        throw new Error("OpenAI API key is not configured.");
      }
      return this.customInstructionReviewer(
        "openai",
        this.config.openAiApiKey,
        this.config.openAiModel,
        executionContext
      ).review(request);
    }

    if (this.config.llmMode === "gemini") {
      if (!this.config.geminiApiKey) {
        throw new Error("Gemini API key is not configured.");
      }
      try {
        return await this.customInstructionReviewer(
          "gemini",
          this.config.geminiApiKey,
          this.config.geminiModel,
          executionContext
        ).review(request);
      } catch (error) {
        const fallbackModel = this.fallbackGeminiModel(error, executionContext);
        if (!fallbackModel) {
          throw error;
        }
        executionContext.progress?.({ stage: "fallback_started" });
        return this.customInstructionReviewer(
          "gemini",
          this.config.geminiApiKey,
          fallbackModel,
          executionContext
        ).review(request);
      }
    }

    throw new Error("Custom instruction LLM review is unavailable in local mode.");
  }

  public async createCapabilityReview(
    request: CapabilityReviewRequest,
    executionContext: ExternalLlmExecutionContext
  ): Promise<CapabilityReviewResult> {
    const provider = this.config.llmMode;
    if (provider !== "openai" && provider !== "gemini") {
      throw new Error("Capability review is unavailable in local mode.");
    }
    const apiKey = provider === "openai" ? this.config.openAiApiKey : this.config.geminiApiKey;
    if (!apiKey) {
      throw new Error("External LLM API key is not configured.");
    }
    return new CapabilityReviewClient({
      provider,
      apiKey,
      model: provider === "openai" ? this.config.openAiModel : this.config.geminiModel,
      ...(provider === "openai" && this.config.openAiReasoningEffort !== undefined
        ? { reasoningEffort: this.config.openAiReasoningEffort }
        : {}),
      ...(provider === "gemini" ? { thinking: this.geminiThinkingOptions(false) } : {}),
      resilienceExecutor: this.resilienceExecutor,
      executionContext
    }).review(request);
  }

  private customInstructionReviewer(
    provider: "openai" | "gemini",
    apiKey: string,
    model: string,
    executionContext: ExternalLlmExecutionContext
  ): CustomInstructionReviewClient {
    return new CustomInstructionReviewClient({
      provider,
      apiKey,
      model,
      ...(provider === "openai" && this.config.openAiReasoningEffort !== undefined
        ? { reasoningEffort: this.config.openAiReasoningEffort }
        : {}),
      ...(provider === "gemini"
        ? { thinking: this.geminiThinkingOptions(model !== this.config.geminiModel) }
        : {}),
      resilienceExecutor: this.resilienceExecutor,
      executionContext,
      ...(this.reviewResponseTelemetry
        ? { responseTelemetry: this.reviewResponseTelemetry }
        : {})
    });
  }

  private skillSelector(
    provider: "openai" | "gemini",
    apiKey: string,
    model: string,
    executionContext: ExternalLlmExecutionContext
  ): SkillSelectionClient {
    return new SkillSelectionClient({
      provider,
      apiKey,
      model,
      ...(provider === "openai" && this.config.openAiReasoningEffort !== undefined
        ? { reasoningEffort: this.config.openAiReasoningEffort }
        : {}),
      ...(provider === "gemini"
        ? { thinking: this.geminiThinkingOptions(model !== this.config.geminiModel) }
        : {}),
      resilienceExecutor: this.resilienceExecutor,
      executionContext
    });
  }

  private geminiThinkingOptions(fallback: boolean): GeminiThinkingOptions {
    if (fallback && this.config.geminiFallbackThinkingLevel !== undefined) {
      return { thinkingLevel: this.config.geminiFallbackThinkingLevel };
    }
    if (fallback && this.config.geminiFallbackThinkingBudget !== undefined) {
      return { thinkingBudget: this.config.geminiFallbackThinkingBudget };
    }
    if (this.config.geminiThinkingLevel !== undefined) {
      return { thinkingLevel: this.config.geminiThinkingLevel };
    }
    if (this.config.geminiThinkingBudget !== undefined) {
      return { thinkingBudget: this.config.geminiThinkingBudget };
    }
    return {};
  }

  private fallbackGeminiModel(
    error: unknown,
    executionContext: ExternalLlmExecutionContext
  ): string | undefined {
    const fallbackModel = this.config.geminiFallbackModel;
    if (!fallbackModel || !executionContext.budget.canStartAfter(0)) {
      return undefined;
    }

    if (error instanceof ExternalLlmHttpError) {
      return error.status === 503 || error.status === 504 ? fallbackModel : undefined;
    }

    if (!(error instanceof ExternalLlmError)) {
      return undefined;
    }

    return ["timeout", "network", "circuit_open"].includes(error.details.kind)
      ? fallbackModel
      : undefined;
  }

  private localImplementationFailureResponse(
    response: MentorResponse,
    requirement: ImplementationRequirement
  ): MentorResponse {
    return {
      title: "編集案生成に失敗",
      sections: [
        {
          heading: "失敗理由",
          items: [
            requirement.reason ?? "実装必須の依頼として扱われています。",
            "localモードは外部LLMを使わないため、任意プロジェクトの有効な apply_patch を生成できません。",
            "説明だけの応答を成功扱いしないため、編集案未生成として停止しました。"
          ]
        },
        {
          heading: "次に必要なこと",
          items: [
            "OpenAIまたはGeminiモードで再実行してください。",
            "対象ファイルを @ で明示すると、編集案生成の精度を上げられます。"
          ]
        }
      ],
      policyWarnings: [
        ...response.policyWarnings,
        "実装必須の依頼で有効な apply_patch が生成されませんでした。"
      ]
    };
  }
}
