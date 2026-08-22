import type { ServerResponse } from "node:http";
import type {
  MentorProgressStage,
  MentorProgressUpdate,
  MentorStreamErrorEvent,
  MentorStreamProgressEvent,
  MentorStreamResultEvent
} from "../../domain/mentorProgress";
import type { MentorResponse } from "../../domain/types";

const PROGRESS_MESSAGES: Readonly<Record<MentorProgressStage, string>> = {
  request_accepted: "リクエストを受け付けました。",
  context_validated: "送信内容の安全確認が完了しました。",
  upstream_attempt_started: "AIへの応答生成を開始しました。",
  upstream_first_chunk_received: "AIから応答を受信しています。",
  retry_scheduled: "一時的な失敗のため、範囲内で再試行します。",
  upstream_response_received: "AI応答の受信が完了しました。",
  response_validating: "応答の形式と安全性を確認しています。",
  response_repair_started: "安全な最終形式へ再生成しています。",
  fallback_started: "代替モデルで応答生成を継続します。"
};

export class MentorSseStream {
  private sequence = 0;
  private startedAt = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private active = false;

  public constructor(
    private readonly response: ServerResponse,
    private readonly requestId: string,
    private readonly now: () => number = Date.now,
    private readonly heartbeatMs: number = 10_000
  ) {}

  public start(): void {
    if (this.active || this.response.writableEnded) {
      return;
    }
    this.active = true;
    this.startedAt = this.now();
    this.response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    this.response.flushHeaders();
    this.heartbeat = setInterval(() => {
      if (!this.response.destroyed && !this.response.writableEnded) {
        this.response.write(": heartbeat\n\n");
      }
    }, this.heartbeatMs);
  }

  public isStarted(): boolean {
    return this.active;
  }

  public progress(update: MentorProgressUpdate): void {
    if (!this.active) {
      return;
    }
    const event: MentorStreamProgressEvent = {
      type: "progress",
      requestId: this.requestId,
      sequence: this.nextSequence(),
      stage: update.stage,
      message: PROGRESS_MESSAGES[update.stage],
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      ...(update.attempt === undefined ? {} : { attempt: update.attempt }),
      ...(update.retryDelayMs === undefined ? {} : { retryDelayMs: update.retryDelayMs })
    };
    this.write("progress", event);
  }

  public complete(result: { readonly response: MentorResponse; readonly safety: string }): void {
    if (!this.active) {
      return;
    }
    const event: MentorStreamResultEvent = {
      type: "result",
      requestId: this.requestId,
      sequence: this.nextSequence(),
      result
    };
    this.write("result", event);
    this.close();
  }

  public fail(status: number, stage: string, message: string): void {
    if (!this.active) {
      return;
    }
    const event: MentorStreamErrorEvent = {
      type: "error",
      requestId: this.requestId,
      sequence: this.nextSequence(),
      status,
      stage,
      message
    };
    this.write("error", event);
    this.close();
  }

  public close(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (!this.response.destroyed && !this.response.writableEnded) {
      this.response.end();
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private write(eventName: string, event: object): void {
    if (!this.response.destroyed && !this.response.writableEnded) {
      this.response.write(`event: ${eventName}\nid: ${this.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }
}
