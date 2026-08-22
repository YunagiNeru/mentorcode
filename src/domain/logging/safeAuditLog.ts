import type { GuardSummary, MaskingEvent } from "../types";

export interface SafeAuditEvent {
  readonly event: string;
  readonly at: string;
  readonly summary?: GuardSummary;
  readonly maskingEvents?: readonly MaskingEvent[];
}

export class SafeAuditLog {
  private readonly events: SafeAuditEvent[] = [];

  public recordScan(summary: GuardSummary, maskingEvents: readonly MaskingEvent[]): SafeAuditEvent {
    const event: SafeAuditEvent = {
      event: "privacy_guard_scan",
      at: new Date().toISOString(),
      summary,
      maskingEvents
    };

    this.events.push(event);
    return event;
  }

  public list(): readonly SafeAuditEvent[] {
    return this.events;
  }
}
