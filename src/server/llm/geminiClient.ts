import type { CustomInstructionContext } from "../../domain/customInstructions";
import type { ContextPackage, ConversationContext, MentorRequest, MentorResponse } from "../../domain/types";
import type { SkillActivationContext } from "../../domain/skills/skillContext";
import type { McpToolContext } from "../../domain/mcp";
import { SseEventDecoder } from "../../domain/sseDecoder";
import { GeminiRequestBuilder } from "./geminiRequestBuilder";
import { MentorResponseGenerator } from "./mentorResponseGenerator";
import {
  type ExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor
} from "./externalLlmResilience";
import type { GeminiThinkingOptions } from "./reasoning";

interface GeminiResponseBody {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
      }[];
    };
  }[];
}

export interface GeminiClientOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly thinking?: GeminiThinkingOptions;
  readonly resilienceExecutor: ExternalLlmResilienceExecutor;
  readonly executionContext: ExternalLlmExecutionContext;
}

export class GeminiClient {
  private readonly requestBuilder = new GeminiRequestBuilder();
  private readonly responseGenerator = new MentorResponseGenerator();

  public constructor(private readonly options: GeminiClientOptions) {}

  public async createMentorResponse(
    request: MentorRequest,
    contextPackage: ContextPackage,
    conversationContext?: ConversationContext,
    customInstruction?: CustomInstructionContext,
    activeSkills?: readonly SkillActivationContext[],
    mcpContext?: McpToolContext
  ): Promise<MentorResponse> {
    return this.responseGenerator.generate({
      source: "Gemini",
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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:streamGenerateContent?alt=sse`;
    return this.options.resilienceExecutor.execute<string>({
      provider: "gemini",
      model: this.options.model,
      responseAttempt,
      context: this.options.executionContext,
      operation: (signal) => fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.options.apiKey
        },
        body: JSON.stringify(this.requestBuilder.build({
          request,
          contextPackage,
          ...(conversationContext === undefined ? {} : { conversationContext }),
          ...(customInstruction === undefined ? {} : { customInstruction }),
          ...(activeSkills === undefined ? {} : { activeSkills }),
          ...(mcpContext === undefined ? {} : { mcpContext }),
          ...(this.options.thinking === undefined ? {} : { thinking: this.options.thinking }),
          repairFeedback
        })),
        signal
      }),
      consumeResponse: (response) => this.consumeStream(response, responseAttempt)
    });
  }

  private async consumeStream(response: Response, responseAttempt: number): Promise<string> {
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("application/json") || !response.body) {
      const body = await response.json() as GeminiResponseBody;
      const text = this.extractText(body);
      if (!text) {
        throw new Error("Gemini response did not contain a mentor JSON payload.");
      }
      this.options.executionContext.progress?.({
        stage: "upstream_first_chunk_received",
        attempt: responseAttempt
      });
      return text;
    }

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const eventDecoder = new SseEventDecoder();
    let result = "";
    let firstChunkReported = false;

    const appendFrames = (frames: ReturnType<SseEventDecoder["feed"]>): void => {
      for (const frame of frames) {
        if (frame.data === "[DONE]") {
          continue;
        }
        const chunk = this.extractText(JSON.parse(frame.data) as GeminiResponseBody);
        if (!chunk) {
          continue;
        }
        result += chunk;
        if (!firstChunkReported) {
          firstChunkReported = true;
          this.options.executionContext.progress?.({
            stage: "upstream_first_chunk_received",
            attempt: responseAttempt
          });
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          appendFrames(eventDecoder.feed(textDecoder.decode()));
          appendFrames(eventDecoder.finish());
          break;
        }
        appendFrames(eventDecoder.feed(textDecoder.decode(value, { stream: true })));
      }
    } finally {
      reader.releaseLock();
    }

    if (!result) {
      throw new Error("Gemini response did not contain a mentor JSON payload.");
    }
    return result;
  }

  private extractText(body: GeminiResponseBody): string {
    const text = body.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter((partText): partText is string => typeof partText === "string")
      .join("");

    return text ?? "";
  }
}
