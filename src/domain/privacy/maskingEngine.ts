import type { DetectionFinding, MaskingEvent } from "../types";

interface RangeReplacement {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
  readonly finding: DetectionFinding;
}

export interface MaskingResult {
  readonly content: string;
  readonly findings: readonly DetectionFinding[];
  readonly events: readonly MaskingEvent[];
}

export class MaskingEngine {
  public mask(content: string, findings: readonly DetectionFinding[]): MaskingResult {
    const replacements = this.createReplacements(findings);
    let masked = "";
    let cursor = 0;

    for (const replacement of replacements) {
      masked += content.slice(cursor, replacement.start);
      masked += replacement.placeholder;
      cursor = replacement.end;
    }

    masked += content.slice(cursor);

    const placeholderById = new Map<string, string>();
    for (const replacement of replacements) {
      placeholderById.set(replacement.finding.id, replacement.placeholder);
    }

    const updatedFindings = findings.map((finding) => {
      const placeholder = placeholderById.get(finding.id);
      return placeholder ? { ...finding, placeholder } : finding;
    });

    return {
      content: masked,
      findings: updatedFindings,
      events: updatedFindings.map((finding) => {
        const event: MaskingEvent = {
          detector: finding.detector,
          type: finding.type,
          severity: finding.severity,
          action: finding.action
        };

        return finding.placeholder ? { ...event, placeholder: finding.placeholder } : event;
      })
    };
  }

  private createReplacements(findings: readonly DetectionFinding[]): readonly RangeReplacement[] {
    const sorted = findings
      .filter((finding) => finding.action === "mask" && finding.end > finding.start)
      .slice()
      .sort((left: DetectionFinding, right: DetectionFinding) => left.start - right.start || right.end - left.end);

    const replacements: RangeReplacement[] = [];
    const typeCounters = new Map<string, number>();
    let lastEnd = -1;

    for (const finding of sorted) {
      if (finding.start < lastEnd) {
        continue;
      }

      const currentCount = (typeCounters.get(finding.type) ?? 0) + 1;
      typeCounters.set(finding.type, currentCount);
      const placeholder = `__${finding.type}_${currentCount}__`;
      replacements.push({
        start: finding.start,
        end: finding.end,
        placeholder,
        finding
      });
      lastEnd = finding.end;
    }

    return replacements;
  }
}
