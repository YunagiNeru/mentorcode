import type { MentorResponse } from "./types";

export type MentorProgressStage =
  | "request_accepted"
  | "context_validated"
  | "upstream_attempt_started"
  | "upstream_first_chunk_received"
  | "retry_scheduled"
  | "upstream_response_received"
  | "response_validating"
  | "response_repair_started"
  | "fallback_started";

export interface MentorProgressUpdate {
  readonly stage: MentorProgressStage;
  readonly attempt?: number;
  readonly retryDelayMs?: number;
}

export type MentorProgressReporter = (update: MentorProgressUpdate) => void;

interface MentorStreamEventBase {
  readonly requestId: string;
  readonly sequence: number;
}

export interface MentorStreamProgressEvent extends MentorStreamEventBase {
  readonly type: "progress";
  readonly stage: MentorProgressStage;
  readonly message: string;
  readonly elapsedMs: number;
  readonly attempt?: number;
  readonly retryDelayMs?: number;
}

export interface MentorStreamResultEvent extends MentorStreamEventBase {
  readonly type: "result";
  readonly result: {
    readonly response: MentorResponse;
    readonly safety: string;
  };
}

export interface MentorStreamErrorEvent extends MentorStreamEventBase {
  readonly type: "error";
  readonly status: number;
  readonly stage: string;
  readonly message: string;
}

export type MentorStreamEvent =
  | MentorStreamProgressEvent
  | MentorStreamResultEvent
  | MentorStreamErrorEvent;
