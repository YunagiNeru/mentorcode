import { describe, expect, it } from "vitest";
import { PrivacyGuard } from "../src/domain/privacy/privacyGuard";
import { SafeAuditLog } from "../src/domain/logging/safeAuditLog";

describe("PrivacyGuard", () => {
  it("blocks .env files before content can become a context package", () => {
    const guard = new PrivacyGuard();
    const result = guard.analyzeFile({
      path: ".env",
      content: `TOKEN=${"sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890"}`
    });

    expect(result.blocked).toBe(true);
    expect(result.excluded).toBe(true);
    expect(result.maskedContent).toBeUndefined();
    expect(result.excludeReason).toContain("環境変数");
  });

  it("masks known API key patterns and removes the raw value from masked content", () => {
    const guard = new PrivacyGuard();
    const fakeKey = "sk-" + "test_abcdefghijklmnopqrstuvwxyz1234567890";
    const result = guard.analyzeFile({
      path: "src/config.ts",
      content: `const apiKey = "${fakeKey}";`
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toContain("__OPENAI_API_KEY_1__");
    expect(result.maskedContent).not.toContain(fakeKey);
    expect(result.findings.some((finding) => finding.type === "OPENAI_API_KEY")).toBe(true);
  });

  it("does not treat an empty secret-like property as a value from the next line", () => {
    const guard = new PrivacyGuard();
    const content = [
      "spring.application.name=task-manager",
      "spring.datasource.url=jdbc:h2:mem:taskdb",
      "spring.datasource.driverClassName=org.h2.Driver",
      "spring.datasource.username=sa",
      "spring.datasource.password=",
      "spring.jpa.database-platform=org.hibernate.dialect.H2Dialect",
      "spring.h2.console.enabled=true",
      "spring.jpa.hibernate.ddl-auto=update"
    ].join("\n");

    const result = guard.analyzeFile({
      path: "src/main/resources/application.properties",
      content
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toBe(content);
    expect(result.findings.some((finding) => finding.type === "GENERIC_SECRET_ASSIGNMENT")).toBe(false);
  });

  it("masks only the same-line value for secret-like assignments", () => {
    const guard = new PrivacyGuard();
    const rawPassword = "developmentPassword123";
    const nextLine = "spring.jpa.hibernate.ddl-auto=update";
    const result = guard.analyzeFile({
      path: "src/main/resources/application.properties",
      content: [
        `spring.datasource.password=${rawPassword}`,
        nextLine
      ].join("\n")
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toContain("spring.datasource.password=__GENERIC_SECRET_ASSIGNMENT_");
    expect(result.maskedContent).toContain(nextLine);
    expect(result.maskedContent).not.toContain(rawPassword);
  });

  it("masks environment-style and dotted password assignments", () => {
    const guard = new PrivacyGuard();
    const result = guard.analyzeFile({
      path: "docker-compose.yml",
      content: [
        "MYSQL_ROOT_PASSWORD: rootpassword",
        "MYSQL_PASSWORD: task_password",
        "spring.datasource.password=task_password"
      ].join("\n")
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).not.toContain("rootpassword");
    expect(result.maskedContent).not.toContain("task_password");
    expect(result.findings.some((finding) => finding.type === "STATIC_PASSWORD_ASSIGNMENT")).toBe(true);
  });

  it("allows environment variable references for password settings", () => {
    const guard = new PrivacyGuard();
    const content = [
      "MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?set MYSQL_ROOT_PASSWORD}",
      "MYSQL_PASSWORD: ${MYSQL_PASSWORD:?set MYSQL_PASSWORD}",
      "spring.datasource.password=${DB_PASSWORD}"
    ].join("\n");
    const result = guard.analyzeFile({
      path: "docker-compose.yml",
      content
    });

    expect(result.blocked).toBe(false);
    expect(result.maskedContent).toBe(content);
    expect(result.findings.some((finding) => finding.type === "GENERIC_SECRET_ASSIGNMENT")).toBe(false);
    expect(result.findings.some((finding) => finding.type === "STATIC_PASSWORD_ASSIGNMENT")).toBe(false);
  });

  it("blocks private key material instead of attempting to mask it", () => {
    const guard = new PrivacyGuard();
    const result = guard.analyzeFile({
      path: "src/keyFixture.txt",
      content: [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEpAIBAAKCAQEA1234567890",
        "-----END RSA PRIVATE KEY-----"
      ].join("\n")
    });

    expect(result.blocked).toBe(true);
    expect(result.excludeReason).toContain("高リスク");
    expect(result.maskedContent).toBeUndefined();
  });

  it("creates context packages with masked content only", () => {
    const guard = new PrivacyGuard();
    const fakeToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const contextPackage = guard.createContextPackage([
      {
        path: "src/service.ts",
        content: `const token = "${fakeToken}";`
      },
      {
        path: "node_modules/library/index.js",
        content: "module.exports = {};"
      }
    ]);

    expect(contextPackage.summary.scannedFiles).toBe(2);
    expect(contextPackage.summary.includedFiles).toBe(1);
    expect(contextPackage.summary.blockedFiles).toBe(1);
    expect(JSON.stringify(contextPackage)).not.toContain(fakeToken);
  });

  it("records audit events without raw secret values", () => {
    const guard = new PrivacyGuard();
    const auditLog = new SafeAuditLog();
    const fakeKey = `AIza${"a".repeat(35)}`;
    const result = guard.analyzeFile({
      path: "src/google.ts",
      content: `const key = "${fakeKey}";`
    });

    auditLog.recordScan(guard.summarize([result]), result.maskingEvents);

    expect(JSON.stringify(auditLog.list())).not.toContain(fakeKey);
    expect(auditLog.list()[0]?.maskingEvents?.[0]?.placeholder).toBe("__GOOGLE_API_KEY_1__");
  });
});
