import {
  SkillSelectionParser,
  type SkillSelectionRequest,
  type SkillSelectionResult
} from "../../domain/skills/skillSelection";
import {
  type ExternalLlmExecutionContext,
  ExternalLlmResilienceExecutor
} from "./externalLlmResilience";
import { SKILL_SELECTION_JSON_SCHEMA } from "./skillSelectionJsonSchema";
import { SkillSelectionPromptBuilder } from "./skillSelectionPrompt";
import {
  geminiThinkingConfig,
  openAiReasoningConfig,
  type GeminiThinkingOptions,
  type OpenAiReasoningEffort
} from "./reasoning";

interface OpenAiSelectionResponseBody {
  readonly output_text?: string;
  readonly output?: readonly {
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
    }[];
  }[];
}

interface GeminiSelectionResponseBody {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        readonly thought?: boolean;
      }[];
    };
  }[];
}

export interface SkillSelectionClientOptions {
  readonly provider: "openai" | "gemini";
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly thinking?: GeminiThinkingOptions;
  readonly resilienceExecutor: ExternalLlmResilienceExecutor;
  readonly executionContext: ExternalLlmExecutionContext;
}

export class SkillSelectionClient {
  private readonly prompt = new SkillSelectionPromptBuilder();
  private readonly parser = new SkillSelectionParser();

  public constructor(private readonly options: SkillSelectionClientOptions) {}

  public async select(request: SkillSelectionRequest): Promise<SkillSelectionResult> {
    const text = this.options.provider === "openai"
      ? await this.fetchOpenAi(request)
      : await this.fetchGemini(request);
    return this.parser.parse(text, request.catalog);
  }

  private async fetchOpenAi(request: SkillSelectionRequest): Promise<string> {
    const body = await this.options.resilienceExecutor.execute<OpenAiSelectionResponseBody>({
      provider: "openai",
      model: this.options.model,
      responseAttempt: 1,
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
          max_output_tokens: 256,
          ...openAiReasoningConfig(this.options.reasoningEffort),
          input: [
            {
              role: "developer",
              content: [{ type: "input_text", text: this.prompt.developerInstructions() }]
            },
            {
              role: "user",
              content: [{ type: "input_text", text: this.prompt.userPayload(request) }]
            }
          ],
          text: {
            format: {
              type: "json_schema",
              name: "skill_selection",
              strict: true,
              schema: SKILL_SELECTION_JSON_SCHEMA
            }
          }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<OpenAiSelectionResponseBody>
    });
    return body.output_text ?? body.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("") ?? "";
  }

  private async fetchGemini(request: SkillSelectionRequest): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.options.model)}:generateContent`;
    const body = await this.options.resilienceExecutor.execute<GeminiSelectionResponseBody>({
      provider: "gemini",
      model: this.options.model,
      responseAttempt: 1,
      context: this.options.executionContext,
      operation: (signal) => fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.options.apiKey
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: this.prompt.developerInstructions() }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: this.prompt.userPayload(request) }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: SKILL_SELECTION_JSON_SCHEMA,
            maxOutputTokens: 256,
            ...geminiThinkingConfig(this.options.thinking ?? {}, "minimal")
          }
        }),
        signal
      }),
      consumeResponse: async (response) => response.json() as Promise<GeminiSelectionResponseBody>
    });
    return body.candidates?.[0]?.content?.parts
      ?.filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text)
      .join("") ?? "";
  }
}
