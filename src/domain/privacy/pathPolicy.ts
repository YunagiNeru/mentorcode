import type { PathDecision, Severity } from "../types";

interface Rule {
  readonly name: string;
  readonly test: (normalizedPath: string, segments: readonly string[]) => boolean;
  readonly reason: string;
  readonly severity: Severity;
}

const DIRECTORY_DENYLIST = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "out",
  "target",
  "vendor"
]);

const EXACT_FILE_DENYLIST = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account.json",
  "firebase-adminsdk.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519"
]);

const DENIED_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".dump",
  ".bak"
];

export class PathPolicy {
  private readonly rules: readonly Rule[];

  public constructor() {
    this.rules = [
      {
        name: "directory-denylist",
        test: (_path, segments) => segments.some((segment) => DIRECTORY_DENYLIST.has(segment)),
        reason: "既定の送信禁止ディレクトリに含まれます",
        severity: "high"
      },
      {
        name: "env-file",
        test: (_path, segments) => {
          const filename = segments.at(-1) ?? "";
          return filename === ".env" || filename.startsWith(".env.");
        },
        reason: "環境変数ファイルは秘密情報を含む可能性が高いため送信禁止です",
        severity: "critical"
      },
      {
        name: "credential-file",
        test: (_path, segments) => EXACT_FILE_DENYLIST.has((segments.at(-1) ?? "").toLowerCase()),
        reason: "認証情報または秘密鍵として扱うファイル名です",
        severity: "critical"
      },
      {
        name: "secret-extension",
        test: (path) => DENIED_EXTENSIONS.some((extension) => path.endsWith(extension)),
        reason: "鍵・証明書・DB dump等の送信禁止拡張子です",
        severity: "critical"
      },
      {
        name: "sql-dump",
        test: (path) => path.endsWith(".sql") || path.endsWith(".sql.gz"),
        reason: "DB dumpの可能性があるため送信禁止です",
        severity: "high"
      }
    ];
  }

  public evaluate(path: string): PathDecision {
    const normalizedPath = this.normalize(path);
    const segments = normalizedPath.split("/").filter(Boolean);

    for (const rule of this.rules) {
      if (rule.test(normalizedPath, segments)) {
        return {
          path,
          allowed: false,
          reason: rule.reason,
          severity: rule.severity
        };
      }
    }

    return {
      path,
      allowed: true,
      reason: "送信禁止パスには該当しません",
      severity: "low"
    };
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, "/").toLowerCase();
  }
}
