import type { CustomInstructionContext } from "../../domain/customInstructions";
import type { ContextPackage, ConversationContext, MentorRequest, MentorResponse } from "../../domain/types";
import type { SkillActivationContext } from "../../domain/skills/skillContext";
import type { McpToolContext } from "../../domain/mcp";
import { MentorPromptBuilder } from "./mentorPrompt";
import { MentorResponseGenerator } from "./mentorResponseGenerator";
import {
  type ExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor
} from "./externalLlmResilience";
import { openAiReasoningConfig, type OpenAiReasoningEffort } from "./reasoning";

interface OpenAiResponseBody {
  readonly output_text?: string;
  readonly output?: readonly unknown[];
}

interface OpenAiOutputContent {
  readonly type?: string;
  readonly text?: string;
}

interface OpenAiOutputItem {
  readonly type?: string;
  readonly content?: readonly OpenAiOutputContent[];
}

export interface OpenAiClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly resilienceExecutor: ExternalLlmResilienceExecutor;
  readonly executionContext: ExternalLlmExecutionContext;
}

export class OpenAiClient {
  private readonly promptBuilder = new MentorPromptBuilder();
  private readonly responseGenerator = new MentorResponseGenerator();

  public constructor(private readonly options: OpenAiClientOptions) {}

  public async createMentorResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext?: ConversationContext,
    customInstruction?: CustomInstructionContext,
    activeSkills?: readonly SkillActivationContext[],
    mcpContext?: McpToolContext
  ): Promise<MentorResponse> {
    return this.responseGenerator.generate({
      source: "OpenAI",
      request,
      contextPackage,
      ...(mcpContext ? { mcpContext } : {}),
      ...(this.options.executionContext.progress === undefined
        ? {}
        : { onProgress: this.options.executionContext.progress }),
      fetchText: (repairFeedback, responseAttempt) => this.fetchMentorText(
        request,
        contextPackage,
        conversationContext,
        customInstruction,
        activeSkills,
        mcpContext,
        repairFeedback,
        responseAttempt
      )
    });
  }

  private async fetchMentorText(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext: ConversationContext | undefined,
    customInstruction: CustomInstructionContext | undefined,
    activeSkills: readonly SkillActivationContext[] | undefined,
    mcpContext: McpToolContext | undefined,
    repairFeedback: readonly string[],
    responseAttempt: number
  ): Promise<string> {
    const body = await this.options.resilienceExecutor.execute<OpenAiResponseBody>({
      provider: "openai",
      model: this.options.model,
      responseAttempt,
      context: this.options.executionContext,
      operation: (signal) => fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          store: false,
          ...openAiReasoningConfig(this.options.reasoningEffort),
          input: [
            {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text: this.promptBuilder.developerInstructions(request)
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: this.promptBuilder.userPayload(
                    request,
                    contextPackage,
                    conversationContext,
                    repairFeedback,
                    customInstruction,
                    activeSkills,
                    mcpContext
                  )
                }
              ]
            }
          ]
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<OpenAiResponseBody>
    });
    return this.extractText(body);
  }

  private extractText(body: OpenAiResponseBody): string {
    if (typeof body.output_text === "string" && body.output_text.trim().length > 0) {
      return body.output_text;
    }

    const nestedText = (body.output ?? [])
      .filter((item): item is OpenAiOutputItem => typeof item === "object" && item !== null)
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text" && typeof content.text === "string")
      .map((content) => content.text as string)
      .join("\n")
      .trim();
    if (nestedText.length > 0) {
      return nestedText;
    }

    const serialized = JSON.stringify(body.output ?? []);
    const match = serialized.match(/\{[\s\S]*"sections"[\s\S]*\}/);
    if (!match) {
      throw new Error("OpenAI response did not contain a mentor JSON payload.");
    }

    return match[0];
  }
}
