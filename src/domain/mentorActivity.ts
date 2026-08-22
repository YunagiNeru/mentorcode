import { HintProfileResolver } from "./mentor/hintProfile";
import { implementationToolActionKinds } from "./agent/toolCalls";
import type { MentorHintLevel, MentorRequest, MentorResponse, MentorToolActionKind } from "./types";

const hintProfiles = new HintProfileResolver();

export type MentorActivityAction = MentorToolActionKind;

interface MutableActivityRecord {
  readonly responseId: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  unread: boolean;
  readonly pendingActions: Set<MentorActivityAction>;
}

export interface RegisterMentorActivityInput {
  readonly responseId: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly response: MentorResponse;
  readonly hintLevel?: MentorRequest["hintLevel"];
  readonly unread: boolean;
}

export interface ResolveMentorActivityActionInput {
  readonly conversationId?: string;
  readonly messageId: string;
  readonly action: MentorActivityAction;
  readonly markRead?: boolean;
}

export interface MentorActivitySnapshot {
  readonly unreadResponses: number;
  readonly pendingProcesses: number;
  readonly badgeValue: number;
  readonly tooltip: string;
}

export class MentorActivityTracker {
  private readonly records = new Map<string, MutableActivityRecord>();

  public registerResponse(input: RegisterMentorActivityInput): MentorActivitySnapshot {
    const pendingActions = new Set<MentorActivityAction>(
      input.messageId ? implementationActionKinds(input.response, input.hintLevel) : []
    );
    const record: MutableActivityRecord = {
      responseId: input.responseId,
      unread: input.unread,
      pendingActions,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {})
    };

    this.records.set(record.responseId, record);
    this.pruneResolvedRecords();
    return this.snapshot();
  }

  public markAllRead(): MentorActivitySnapshot {
    for (const record of this.records.values()) {
      record.unread = false;
    }

    this.pruneResolvedRecords();
    return this.snapshot();
  }

  public markConversationRead(conversationId: string): MentorActivitySnapshot {
    for (const record of this.records.values()) {
      if (record.conversationId === conversationId) {
        record.unread = false;
      }
    }

    this.pruneResolvedRecords();
    return this.snapshot();
  }

  public resolveAction(input: ResolveMentorActivityActionInput): MentorActivitySnapshot {
    let matchedRecord = false;
    for (const record of this.records.values()) {
      if (record.messageId !== input.messageId) {
        continue;
      }
      if (input.conversationId && record.conversationId && record.conversationId !== input.conversationId) {
        continue;
      }

      matchedRecord = true;
      if (input.markRead) {
        record.unread = false;
      }
      record.pendingActions.delete(input.action);
    }

    if (!matchedRecord && input.markRead && input.conversationId) {
      for (const record of this.records.values()) {
        if (record.conversationId === input.conversationId) {
          record.unread = false;
        }
      }
    }

    this.pruneResolvedRecords();
    return this.snapshot();
  }

  public snapshot(): MentorActivitySnapshot {
    let unreadResponses = 0;
    let pendingProcesses = 0;

    for (const record of this.records.values()) {
      if (record.unread) {
        unreadResponses += 1;
      }
      pendingProcesses += record.pendingActions.size;
    }

    const badgeValue = unreadResponses + pendingProcesses;
    return {
      unreadResponses,
      pendingProcesses,
      badgeValue,
      tooltip: this.tooltip(unreadResponses, pendingProcesses)
    };
  }

  private pruneResolvedRecords(): void {
    for (const [key, record] of this.records.entries()) {
      if (!record.unread && record.pendingActions.size === 0) {
        this.records.delete(key);
      }
    }
  }

  private tooltip(unreadResponses: number, pendingProcesses: number): string {
    if (unreadResponses === 0 && pendingProcesses === 0) {
      return "Mentor Code の未読通知はありません";
    }

    return `未読応答 ${unreadResponses} 件 / 対応待ち ${pendingProcesses} 件`;
  }
}

export function implementationActionKinds(
  response: MentorResponse,
  hintLevel: MentorRequest["hintLevel"] = "low"
): readonly MentorActivityAction[] {
  if (!hintProfiles.resolve(hintLevel).allowsImplementationActions) {
    return [];
  }

  return implementationToolActionKinds(response);
}

export function normalizeActivityHintLevel(value: MentorRequest["hintLevel"]): MentorHintLevel {
  return hintProfiles.resolve(value).level;
}
