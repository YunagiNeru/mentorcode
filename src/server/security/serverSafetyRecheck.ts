import { PrivacyGuard } from "../../domain/privacy/privacyGuard";
import type { ContextPackage, FileCandidate } from "../../domain/types";

export interface RecheckResult {
  readonly accepted: boolean;
  readonly reason: string;
}

export class ServerSafetyRecheck {
  public constructor(private readonly guard: PrivacyGuard = new PrivacyGuard()) {}

  public async verify(contextPackage: ContextPackage): Promise<RecheckResult> {
    const candidates: FileCandidate[] = contextPackage.files.map((file) => ({
      path: file.path,
      content: file.maskedContent
    }));

    const results = [];
    for (const candidate of candidates) {
      results.push(await this.guard.analyzeFileAsync(candidate));
    }
    const unsafe = results.find((result) => {
      if (result.blocked || result.excluded) {
        return true;
      }

      return result.findings.some((finding) => finding.action === "mask" || finding.action === "block");
    });

    if (unsafe) {
      return {
        accepted: false,
        reason: `Server-side safety recheck rejected ${unsafe.path}.`
      };
    }

    return {
      accepted: true,
      reason: "Server-side safety recheck accepted masked context."
    };
  }
}
