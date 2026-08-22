import { HintProfileResolver } from "../domain/mentor/hintProfile";
import { commandToolCall, mcpToolCall, patchToolCall, requiresManualImplementation } from "../domain/agent/toolCalls";
import type { MentorHintLevel, MentorResponse } from "../domain/types";

const hintProfiles = new HintProfileResolver();

export interface EditContinuationPolicyInput {
  readonly hintLevel: MentorHintLevel;
  readonly response: MentorResponse;
  readonly alreadyContinued: boolean;
  readonly serverMentorPending: boolean;
}

export function shouldContinueAfterEditApplied(input: EditContinuationPolicyInput): boolean {
  if (input.alreadyContinued || input.serverMentorPending) {
    return false;
  }

  if (!hintProfiles.resolve(input.hintLevel).allowsImplementationActions) {
    return false;
  }

  if (!patchToolCall(input.response) && !requiresManualImplementation(input.response)) {
    return false;
  }

  return !commandToolCall(input.response) && !mcpToolCall(input.response);
}

export interface TimelineActionCandidate {
  readonly key: string;
  readonly label: string;
  readonly orderExempt?: boolean;
}

export function firstBlockingTimelineAction(
  actions: readonly TimelineActionCandidate[]
): TimelineActionCandidate | undefined {
  return actions.find((action) => !action.orderExempt);
}

export function isTimelineActionInOrder(
  actions: readonly TimelineActionCandidate[],
  actionKey: string
): boolean {
  const firstAction = firstBlockingTimelineAction(actions);
  return !firstAction || firstAction.key === actionKey;
}

export interface PatchApplyFailureRetryPolicyInput {
  readonly hasPatchToolCall: boolean;
  readonly targetFileCount: number;
  readonly alreadyRetried: boolean;
  readonly serverMentorPending: boolean;
  readonly workspaceTrusted: boolean;
}

export function shouldRetryAfterPatchApplyFailed(input: PatchApplyFailureRetryPolicyInput): boolean {
  return input.hasPatchToolCall &&
    input.targetFileCount > 0 &&
    !input.alreadyRetried &&
    !input.serverMentorPending &&
    input.workspaceTrusted;
}
