import { join } from "node:path";
import { PrivacyGuard } from "../domain/privacy/privacyGuard";
import { BonsaiProjectReviewer } from "./bonsaiProjectReviewer";
import { BonsaiRuntime } from "./bonsaiRuntime";
import { BonsaiSemanticDetector } from "./bonsaiSemanticDetector";
import { BonsaiCapabilityReviewer } from "./bonsaiCapabilityReviewer";

export interface BonsaiPrivacyGuardFactoryOptions {
  readonly root: string;
  readonly requireSemanticScan: boolean;
  readonly timeoutMs?: number;
}

export class BonsaiPrivacyGuardFactory {
  public create(options: BonsaiPrivacyGuardFactoryOptions): PrivacyGuard {
    const runtime = new BonsaiRuntime({
      root: options.root,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });

    return new PrivacyGuard({
      requireSemanticScan: options.requireSemanticScan,
      semanticDetector: new BonsaiSemanticDetector({
        runtime,
        blockConfidence: 0.7
      })
    });
  }

  public createForExtensionRoot(extensionRoot: string): PrivacyGuard {
    return this.create({
      root: join(extensionRoot, "vendor", "bonsai"),
      requireSemanticScan: true,
      timeoutMs: 30_000
    });
  }

  public createProjectReviewer(options: Omit<BonsaiPrivacyGuardFactoryOptions, "requireSemanticScan">): BonsaiProjectReviewer {
    return new BonsaiProjectReviewer({
      runtime: new BonsaiRuntime({
        root: options.root,
        timeoutMs: options.timeoutMs ?? 45_000,
        maxOutputBytes: 48_000
      })
    });
  }

  public createProjectReviewerForExtensionRoot(extensionRoot: string): BonsaiProjectReviewer {
    return this.createProjectReviewer({
      root: join(extensionRoot, "vendor", "bonsai"),
      timeoutMs: 45_000
    });
  }

  public createCapabilityReviewerForExtensionRoot(extensionRoot: string): BonsaiCapabilityReviewer {
    return new BonsaiCapabilityReviewer(new BonsaiRuntime({
      root: join(extensionRoot, "vendor", "bonsai"),
      timeoutMs: 45_000,
      maxOutputBytes: 32_000
    }));
  }
}
