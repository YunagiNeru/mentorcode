import type { FileGuardResult, MentorRequest } from "../types";
import { PrivacyGuard } from "./privacyGuard";

export interface MentorRequestGuardDecision {
  readonly accepted: boolean;
  readonly request: MentorRequest;
  readonly reason: string;
  readonly results: readonly FileGuardResult[];
}

interface RequestField {
  readonly key: "task";
  readonly path: string;
  readonly content: string;
}

export class MentorRequestGuard {
  public constructor(private readonly guard: PrivacyGuard) {}

  public async sanitize(request: MentorRequest): Promise<MentorRequestGuardDecision> {
    const fields = this.toFields(request);
    const results: FileGuardResult[] = [];
    const maskedValues = new Map<RequestField["key"], string>();

    for (const field of fields) {
      const result = await this.guard.analyzeFileAsync({
        path: field.path,
        content: field.content
      });
      results.push(result);

      if (result.blocked || result.excluded || result.maskedContent === undefined) {
        return {
          accepted: false,
          request,
          reason: result.excludeReason ?? `${field.path} に送信禁止の機密情報候補があります。`,
          results
        };
      }

      maskedValues.set(field.key, result.maskedContent);
    }

    return {
      accepted: true,
      request: {
        ...request,
        task: maskedValues.get("task") ?? request.task
      },
      reason: "Mentor request safety check accepted masked user input.",
      results
    };
  }

  private toFields(request: MentorRequest): readonly RequestField[] {
    const fields: RequestField[] = [
      {
        key: "task",
        path: "mentor-request/task.txt",
        content: request.task
      }
    ];

    return fields;
  }
}
