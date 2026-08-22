import type { DetectionFinding, GuardAction, Severity } from "../types";
import { EntropyCalculator } from "./entropy";

export interface Detector {
  readonly name: string;
  detect(content: string): readonly DetectionFinding[];
}

interface PatternRule {
  readonly type: string;
  readonly regex: RegExp;
  readonly severity: Severity;
  readonly action: GuardAction;
  readonly reason: string;
  readonly group?: number;
}

let findingCounter = 0;

function createFinding(
  detector: string,
  type: string,
  severity: Severity,
  action: GuardAction,
  start: number,
  end: number,
  reason: string
): DetectionFinding {
  findingCounter += 1;
  return {
    id: `${detector}-${findingCounter}`,
    detector,
    type,
    severity,
    action,
    start,
    end,
    reason
  };
}

export class SecretPatternDetector implements Detector {
  public readonly name = "secret-pattern";

  private readonly rules: readonly PatternRule[] = [
    {
      type: "SSH_PRIVATE_KEY",
      regex: /-----BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----[\s\S]+?-----END (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----/g,
      severity: "critical",
      action: "block",
      reason: "秘密鍵本文は値の存在自体が高リスクです"
    },
    {
      type: "AWS_ACCESS_KEY_ID",
      regex: /\bA(?:KIA|SIA)[A-Z0-9]{16}\b/g,
      severity: "high",
      action: "mask",
      reason: "AWSアクセスキー形式に一致しました"
    },
    {
      type: "GITHUB_TOKEN",
      regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g,
      severity: "high",
      action: "mask",
      reason: "GitHub token形式に一致しました"
    },
    {
      type: "OPENAI_API_KEY",
      regex: /\bsk-[A-Za-z0-9_-]{24,}\b/g,
      severity: "high",
      action: "mask",
      reason: "APIキー形式に一致しました"
    },
    {
      type: "GOOGLE_API_KEY",
      regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
      severity: "high",
      action: "mask",
      reason: "Google APIキー形式に一致しました"
    },
    {
      type: "JWT",
      regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      severity: "high",
      action: "mask",
      reason: "JWT形式に一致しました"
    },
    {
      type: "CONNECTION_STRING",
      regex: /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"'`<>]+/gi,
      severity: "high",
      action: "mask",
      reason: "接続文字列形式に一致しました"
    },
    {
      type: "STATIC_PASSWORD_ASSIGNMENT",
      regex: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*)\b[^\S\r\n]*[:=][^\S\r\n]*["']?(root|admin|password|passwd|changeme|change_me|secret|test|demo|example|rootpassword|taskpassword|task_password)["']?/gi,
      severity: "medium",
      action: "mask",
      reason: "固定の弱いパスワード値への代入を検出しました",
      group: 2
    },
    {
      type: "GENERIC_SECRET_ASSIGNMENT",
      regex: /\b([A-Za-z0-9_.-]*(?:api[_.-]?key|access[_.-]?token|auth[_.-]?token|client[_.-]?secret|secret|password|passwd|pwd)[A-Za-z0-9_.-]*)\b[^\S\r\n]*[:=][^\S\r\n]*["']?([^\s"'`<>]{8,})/gi,
      severity: "medium",
      action: "mask",
      reason: "秘密情報らしいキー名への代入を検出しました",
      group: 2
    }
  ];

  public detect(content: string): readonly DetectionFinding[] {
    const findings: DetectionFinding[] = [];

    for (const rule of this.rules) {
      for (const match of content.matchAll(rule.regex)) {
        const matchedText = match[0];
        const fullStart = match.index ?? 0;
        const capturedValue = rule.group ? match[rule.group] : undefined;
        if (capturedValue && (this.isPlaceholder(capturedValue) || this.isEnvironmentReference(capturedValue))) {
          continue;
        }
        const start = capturedValue
          ? fullStart + matchedText.lastIndexOf(capturedValue)
          : fullStart;
        const end = start + (capturedValue ?? matchedText).length;

        findings.push(
          createFinding(
            this.name,
            rule.type,
            rule.severity,
            rule.action,
            start,
            end,
            rule.reason
          )
        );
      }
    }

    return findings;
  }

  private isPlaceholder(value: string): boolean {
    return /^__[A-Z0-9_]+_\d+__$/.test(value);
  }

  private isEnvironmentReference(value: string): boolean {
    const trimmed = value.trim().replace(/[),;]+$/g, "");
    return (
      /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[?=-][^}]*)?\}$/.test(trimmed) ||
      /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::[?=-][^}]*)?$/.test(trimmed) ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ||
      /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(trimmed)
    );
  }
}

export class EntropyDetector implements Detector {
  public readonly name = "entropy";
  private readonly calculator = new EntropyCalculator();
  private readonly tokenRegex = /\b[A-Za-z0-9_./+-]{32,256}={0,2}\b/g;

  public detect(content: string): readonly DetectionFinding[] {
    const findings: DetectionFinding[] = [];

    for (const match of content.matchAll(this.tokenRegex)) {
      const token = match[0];
      if (!this.calculator.isHighEntropyToken(token)) {
        continue;
      }

      findings.push(
        createFinding(
          this.name,
          "HIGH_ENTROPY_TOKEN",
          "medium",
          "mask",
          match.index ?? 0,
          (match.index ?? 0) + token.length,
          "高エントロピーの長い文字列を検出しました"
        )
      );
    }

    return findings;
  }
}

export class PiiDetector implements Detector {
  public readonly name = "pii";

  private readonly rules: readonly PatternRule[] = [
    {
      type: "EMAIL",
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      severity: "medium",
      action: "mask",
      reason: "メールアドレス形式に一致しました"
    },
    {
      type: "PHONE",
      regex: /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)\d{2,4}[-.\s]?\d{3,4}\b/g,
      severity: "medium",
      action: "mask",
      reason: "電話番号らしい形式に一致しました"
    },
    {
      type: "INTERNAL_URL",
      regex: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|[^/\s"'`<>]+\.internal)(?::\d+)?[^\s"'`<>]*/gi,
      severity: "medium",
      action: "mask",
      reason: "内部URLまたはローカルURLを検出しました"
    }
  ];

  public detect(content: string): readonly DetectionFinding[] {
    const findings: DetectionFinding[] = [];

    for (const rule of this.rules) {
      for (const match of content.matchAll(rule.regex)) {
        findings.push(
          createFinding(
            this.name,
            rule.type,
            rule.severity,
            rule.action,
            match.index ?? 0,
            (match.index ?? 0) + match[0].length,
            rule.reason
          )
        );
      }
    }

    return findings;
  }
}

export class LocalSemanticDetector implements Detector {
  public readonly name = "local-semantic";

  private readonly patterns: readonly RegExp[] = [
    /(?:社内|内部|confidential|secret|credential|token|password|api key|認証情報|秘密)/i,
    /(?:顧客|取引先|社員|個人情報|住所|電話番号|メールアドレス)/
  ];

  public detect(content: string): readonly DetectionFinding[] {
    const findings: DetectionFinding[] = [];
    const lines = content.split(/\r?\n/);
    let offset = 0;

    for (const line of lines) {
      for (const pattern of this.patterns) {
        const match = line.match(pattern);
        if (!match || match.index === undefined) {
          continue;
        }

        findings.push(
          createFinding(
            this.name,
            "SEMANTIC_CONFIDENTIAL_HINT",
            "low",
            "warn",
            offset + match.index,
            offset + match.index + match[0].length,
            "機密文脈を示す語を検出しました"
          )
        );
        break;
      }
      offset += line.length + 1;
    }

    return findings;
  }
}
