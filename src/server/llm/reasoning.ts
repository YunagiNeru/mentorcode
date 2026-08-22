export type OpenAiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiThinkingOptions {
  readonly thinkingLevel?: GeminiThinkingLevel;
  readonly thinkingBudget?: number;
}

export function openAiReasoningConfig(
  effort: OpenAiReasoningEffort | undefined
): { readonly reasoning: { readonly effort: OpenAiReasoningEffort } } | Record<never, never> {
  return effort === undefined ? {} : { reasoning: { effort } };
}

export function geminiThinkingConfig(
  options: GeminiThinkingOptions,
  defaultLevel?: GeminiThinkingLevel
): {
  readonly thinkingConfig:
    | { readonly thinkingLevel: GeminiThinkingLevel }
    | { readonly thinkingBudget: number };
} | Record<never, never> {
  if (options.thinkingBudget !== undefined) {
    return { thinkingConfig: { thinkingBudget: options.thinkingBudget } };
  }

  const thinkingLevel = options.thinkingLevel ?? defaultLevel;
  return thinkingLevel === undefined
    ? {}
    : { thinkingConfig: { thinkingLevel } };
}
