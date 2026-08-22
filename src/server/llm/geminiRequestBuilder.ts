import type {
  ContextPackage,
  ConversationContext,
  MentorRequest
} from "../../domain/types";
import type { CustomInstructionContext } from "../../domain/customInstructions";
import type { SkillActivationContext } from "../../domain/skills/skillContext";
import type { McpToolContext } from "../../domain/mcp";
import { MentorPromptBuilder } from "./mentorPrompt";
import { MENTOR_RESPONSE_JSON_SCHEMA } from "./mentorResponseJsonSchema";
import { geminiThinkingConfig, type GeminiThinkingOptions } from "./reasoning";

export interface GeminiRequestBuilderInput {
  readonly request: MentorRequest;
  readonly contextPackage: ContextPackage;
  readonly conversationContext?: ConversationContext;
  readonly repairFeedback: readonly string[];
  readonly customInstruction?: CustomInstructionContext;
  readonly activeSkills?: readonly SkillActivationContext[];
  readonly mcpContext?: McpToolContext;
  readonly thinking?: GeminiThinkingOptions;
}

export interface GeminiGenerateContentRequest {
  readonly system_instruction: {
    readonly parts: readonly { readonly text: string }[];
  };
  readonly contents: readonly {
    readonly role: "user";
    readonly parts: readonly { readonly text: string }[];
  }[];
  readonly generationConfig: {
    readonly responseMimeType: "application/json";
    readonly responseJsonSchema: typeof MENTOR_RESPONSE_JSON_SCHEMA;
  };
}

export class GeminiRequestBuilder {
  private readonly promptBuilder = new MentorPromptBuilder();

  public build(input: GeminiRequestBuilderInput): GeminiGenerateContentRequest {
    return {
      system_instruction: {
        parts: [
          {
            text: this.promptBuilder.developerInstructions(input.request)
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: this.promptBuilder.userPayload(
                input.request,
                input.contextPackage,
                input.conversationContext,
                input.repairFeedback,
                input.customInstruction,
                input.activeSkills,
                input.mcpContext
              )
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: MENTOR_RESPONSE_JSON_SCHEMA,
        ...geminiThinkingConfig(input.thinking ?? {})
      }
    };
  }
}
