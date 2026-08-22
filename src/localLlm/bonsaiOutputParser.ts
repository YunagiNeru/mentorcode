export interface BonsaiClassification {
  readonly verdict: "safe" | "credential_likely" | "private_internal" | "customer_or_personal_data" | "business_confidential_context";
  readonly confidence: number;
  readonly educationSummary?: string;
  readonly riskPoints?: readonly string[];
  readonly recommendedAction?: string;
}

type ParsedClassification = Partial<BonsaiClassification>;

export class BonsaiOutputParser {
  public parse(output: string): BonsaiClassification {
    let lastClassification: BonsaiClassification | undefined;

    for (const candidate of this.extractJsonObjects(output)) {
      const classification = this.tryParseClassification(candidate);
      if (classification) {
        lastClassification = classification;
      }
    }

    if (!lastClassification) {
      throw new Error("Bonsai local LLM did not return a valid classification JSON.");
    }

    return lastClassification;
  }

  private extractJsonObjects(output: string): readonly string[] {
    const objects: string[] = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < output.length; index += 1) {
      const character = output[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (character === "\\") {
          escaped = true;
          continue;
        }

        if (character === "\"") {
          inString = false;
        }
        continue;
      }

      if (character === "\"") {
        inString = true;
        continue;
      }

      if (character === "{") {
        if (depth === 0) {
          start = index;
        }
        depth += 1;
        continue;
      }

      if (character !== "}") {
        continue;
      }

      if (depth === 0) {
        start = -1;
        continue;
      }

      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(output.slice(start, index + 1));
        start = -1;
      }
    }

    return objects;
  }

  private tryParseClassification(candidate: string): BonsaiClassification | undefined {
    let parsed: ParsedClassification;
    try {
      parsed = JSON.parse(candidate) as ParsedClassification;
    } catch {
      return undefined;
    }

    if (!this.isKnownVerdict(parsed.verdict)) {
      return undefined;
    }

    const confidence = this.normalizeConfidence(parsed.confidence);
    return {
      verdict: parsed.verdict,
      confidence: Math.max(0, Math.min(1, confidence)),
      ...(typeof parsed.educationSummary === "string" ? { educationSummary: parsed.educationSummary.slice(0, 600) } : {}),
      ...(Array.isArray(parsed.riskPoints)
        ? { riskPoints: parsed.riskPoints.map((point) => this.riskPointText(point)).filter((point): point is string => point !== undefined).slice(0, 4).map((point) => point.slice(0, 240)) }
        : {}),
      ...(typeof parsed.recommendedAction === "string" ? { recommendedAction: parsed.recommendedAction.slice(0, 300) } : {})
    };
  }

  private normalizeConfidence(value: unknown): number {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value !== "string") {
      return 1;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    const lowered = value.toLowerCase();
    if (lowered === "high") {
      return 0.9;
    }

    if (lowered === "medium") {
      return 0.5;
    }

    if (lowered === "low") {
      return 0.2;
    }

    return 1;
  }

  private riskPointText(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.description === "string") {
      return record.description;
    }

    if (typeof record.point === "string") {
      return record.point;
    }

    return undefined;
  }

  private isKnownVerdict(value: unknown): value is BonsaiClassification["verdict"] {
    return (
      value === "safe" ||
      value === "credential_likely" ||
      value === "private_internal" ||
      value === "customer_or_personal_data" ||
      value === "business_confidential_context"
    );
  }
}
