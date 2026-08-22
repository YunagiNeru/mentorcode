import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerConfigLoader, DEFAULT_CLIENT_UPDATE_URL } from "../src/server/config";

describe("AppServerConfigLoader", () => {
  it("accepts Gemini mode with a Gemini API key", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_LLM_MODE: "gemini",
      GEMINI_API_KEY: "test-gemini-api-key",
      GEMINI_MODEL: "gemini-3.5-flash"
    });

    expect(config.llmMode).toBe("gemini");
    expect(config.geminiApiKey).toBe("test-gemini-api-key");
    expect(config.geminiModel).toBe("gemini-3.5-flash");
    expect(config.llmMaxCalls).toBe(3);
    expect(config.llmMaxTransportRetries).toBe(1);
    expect(config.llmAttemptTimeoutMs).toBe(45_000);
    expect(config.llmTotalTimeoutMs).toBe(105_000);
    expect(config.llmRetryBaseDelayMs).toBe(1_000);
    expect(config.llmCircuitFailureThreshold).toBe(3);
    expect(config.llmCircuitOpenMs).toBe(30_000);
    expect(config.mentorStreamingEnabled).toBe(false);
    expect(config.skillsExecutionEnabled).toBe(true);
    expect(config.mcpToolsEnabled).toBe(true);
    expect(config.customInstructionExecutionEnabled).toBe(true);
    expect(config.customInstructionReviewEnabled).toBe(true);
    expect(config.capabilityReviewEnabled).toBe(true);
  });

  it("loads models and reasoning settings from a JSON config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "mentor-app-server-config-"));
    const configPath = join(directory, "app-server.config.json");
    writeFileSync(configPath, JSON.stringify({
      openAiModel: "file-openai-model",
      openAiReasoningEffort: "high",
      geminiModel: "file-gemini-model",
      geminiThinkingLevel: "medium",
      geminiFallbackModel: "file-gemini-fallback",
      geminiFallbackThinkingLevel: "low"
    }));

    try {
      const config = new AppServerConfigLoader().fromEnv({
        MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
        MENTOR_LLM_MODE: "gemini",
        GEMINI_API_KEY: "test-gemini-api-key",
        MENTOR_APP_SERVER_CONFIG: configPath
      });

      expect(config.openAiModel).toBe("file-openai-model");
      expect(config.openAiReasoningEffort).toBe("high");
      expect(config.geminiModel).toBe("file-gemini-model");
      expect(config.geminiThinkingLevel).toBe("medium");
      expect(config.geminiFallbackModel).toBe("file-gemini-fallback");
      expect(config.geminiFallbackThinkingLevel).toBe("low");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps environment variables higher priority than the JSON config file", () => {
    const directory = mkdtempSync(join(tmpdir(), "mentor-app-server-config-"));
    const configPath = join(directory, "app-server.config.json");
    writeFileSync(configPath, JSON.stringify({
      openAiModel: "file-model",
      openAiReasoningEffort: "low",
      geminiThinkingLevel: "low"
    }));

    try {
      const config = new AppServerConfigLoader().fromEnv({
        MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
        MENTOR_APP_SERVER_CONFIG: configPath,
        OPENAI_MODEL: "environment-model",
        OPENAI_REASONING_EFFORT: "medium",
        GEMINI_THINKING_LEVEL: "high"
      });

      expect(config.openAiModel).toBe("environment-model");
      expect(config.openAiReasoningEffort).toBe("medium");
      expect(config.geminiThinkingLevel).toBe("high");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("supports Gemini thinking budgets and rejects incompatible settings", () => {
    const budgetDirectory = mkdtempSync(join(tmpdir(), "mentor-app-server-config-"));
    const budgetPath = join(budgetDirectory, "app-server.config.json");
    writeFileSync(budgetPath, JSON.stringify({ geminiThinkingBudget: 4096 }));

    try {
      const config = new AppServerConfigLoader().fromEnv({
        MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
        MENTOR_APP_SERVER_CONFIG: budgetPath
      });
      expect(config.geminiThinkingBudget).toBe(4096);
    } finally {
      rmSync(budgetDirectory, { recursive: true, force: true });
    }

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      GEMINI_THINKING_LEVEL: "medium",
      GEMINI_THINKING_BUDGET: "4096"
    })).toThrow("GEMINI_THINKING_LEVEL and GEMINI_THINKING_BUDGET cannot be configured together.");

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      GEMINI_THINKING_LEVEL: "invalid"
    })).toThrow("GEMINI_THINKING_LEVEL must be minimal, low, medium, or high.");
  });

  it("requires a Gemini API key in Gemini mode", () => {
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_LLM_MODE: "gemini",
      MENTOR_ADMIN_ENABLED: "false"
    })).toThrow("GEMINI_API_KEY is required when MENTOR_LLM_MODE=gemini.");
  });

  it("allows fail-safe rollback of mentor event streaming", () => {
    const disabled = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_STREAMING_ENABLED: "false"
    });
    expect(disabled.mentorStreamingEnabled).toBe(false);

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_STREAMING_ENABLED: "sometimes"
    })).toThrow("MENTOR_STREAMING_ENABLED must be true or false.");
  });

  it("allows independent fail-safe rollback of custom instruction execution and review", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_CUSTOM_INSTRUCTION_EXECUTION_ENABLED: "false",
      MENTOR_CUSTOM_INSTRUCTION_REVIEW_ENABLED: "false"
    });

    expect(config.customInstructionExecutionEnabled).toBe(false);
    expect(config.customInstructionReviewEnabled).toBe(false);
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_CUSTOM_INSTRUCTION_REVIEW_ENABLED: "sometimes"
    })).toThrow("MENTOR_CUSTOM_INSTRUCTION_REVIEW_ENABLED must be true or false.");
  });

  it("allows independent fail-safe rollback of Skills execution", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_SKILLS_EXECUTION_ENABLED: "false"
    });

    expect(config.skillsExecutionEnabled).toBe(false);
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_SKILLS_EXECUTION_ENABLED: "sometimes"
    })).toThrow("MENTOR_SKILLS_EXECUTION_ENABLED must be true or false.");
  });

  it("allows independent fail-safe rollback of capability review", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_CAPABILITY_REVIEW_ENABLED: "false"
    });

    expect(config.capabilityReviewEnabled).toBe(false);
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_CAPABILITY_REVIEW_ENABLED: "sometimes"
    })).toThrow("MENTOR_CAPABILITY_REVIEW_ENABLED must be true or false.");
  });

  it("allows independent fail-safe rollback of MCP Tools", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_MCP_TOOLS_ENABLED: "false"
    });

    expect(config.mcpToolsEnabled).toBe(false);
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_MCP_TOOLS_ENABLED: "sometimes"
    })).toThrow("MENTOR_MCP_TOOLS_ENABLED must be true or false.");
  });

  it("accepts only a distinct, valid Gemini fallback model", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      GEMINI_MODEL: "primary-model",
      GEMINI_FALLBACK_MODEL: "fallback-model"
    });
    expect(config.geminiFallbackModel).toBe("fallback-model");

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      GEMINI_MODEL: "same-model",
      GEMINI_FALLBACK_MODEL: "same-model"
    })).toThrow("GEMINI_FALLBACK_MODEL must differ from GEMINI_MODEL.");

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      GEMINI_FALLBACK_MODEL: "../../unsafe"
    })).toThrow("GEMINI_FALLBACK_MODEL must be a valid provider model ID.");
  });

  it("accepts an explicitly bounded external LLM availability policy", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_LLM_MAX_CALLS: "2",
      MENTOR_LLM_MAX_TRANSPORT_RETRIES: "1",
      MENTOR_LLM_ATTEMPT_TIMEOUT_MS: "30000",
      MENTOR_LLM_TOTAL_TIMEOUT_MS: "70000",
      MENTOR_LLM_RETRY_BASE_DELAY_MS: "500",
      MENTOR_LLM_CIRCUIT_FAILURE_THRESHOLD: "4",
      MENTOR_LLM_CIRCUIT_OPEN_MS: "45000",
      MENTOR_LLM_MAX_CONCURRENT_REQUESTS: "6"
    });

    expect(config.llmMaxCalls).toBe(2);
    expect(config.llmMaxTransportRetries).toBe(1);
    expect(config.llmAttemptTimeoutMs).toBe(30_000);
    expect(config.llmTotalTimeoutMs).toBe(70_000);
    expect(config.llmRetryBaseDelayMs).toBe(500);
    expect(config.llmCircuitFailureThreshold).toBe(4);
    expect(config.llmCircuitOpenMs).toBe(45_000);
    expect(config.llmMaxConcurrentRequests).toBe(6);
  });

  it("rejects external LLM policies that can outlive or exceed their request budget", () => {
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_LLM_MAX_CALLS: "2",
      MENTOR_LLM_MAX_TRANSPORT_RETRIES: "2"
    })).toThrow("MENTOR_LLM_MAX_TRANSPORT_RETRIES must be less than MENTOR_LLM_MAX_CALLS.");

    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_LLM_ATTEMPT_TIMEOUT_MS: "60000",
      MENTOR_LLM_TOTAL_TIMEOUT_MS: "60000"
    })).toThrow("MENTOR_LLM_ATTEMPT_TIMEOUT_MS must be less than MENTOR_LLM_TOTAL_TIMEOUT_MS.");
  });

  it("does not expose server-side Bonsai runtime settings", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890"
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.requiredClientVersion).toBeUndefined();
    expect(config.clientUpdateUrl).toBe(DEFAULT_CLIENT_UPDATE_URL);
    expect("localLlmRequired" in config).toBe(false);
    expect("bonsaiRoot" in config).toBe(false);
  });

  it("allows enabling exact client version checks with a download URL", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_REQUIRED_CLIENT_VERSION: " 0.1.3 ",
      MENTOR_CLIENT_UPDATE_URL: "https://mentor-code.ginjiro.homes/downloads/latest#ignored"
    });

    expect(config.requiredClientVersion).toBe("0.1.3");
    expect(config.clientUpdateUrl).toBe("https://mentor-code.ginjiro.homes/downloads/latest");
  });

  it("rejects invalid client update URLs", () => {
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_CLIENT_UPDATE_URL: "mentor-code.ginjiro.homes/downloads/latest"
    })).toThrow("MENTOR_CLIENT_UPDATE_URL must be an http or https absolute URL.");
  });

  it("allows binding to all interfaces for reverse proxy or container deployments", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_SERVER_HOST: "0.0.0.0"
    });

    expect(config.host).toBe("0.0.0.0");
  });

  it("rejects unsupported bind hosts", () => {
    expect(() => new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_SERVER_HOST: "192.168.0.10"
    })).toThrow("MENTOR_SERVER_HOST must be 127.0.0.1 or 0.0.0.0.");
  });

  it("allows the public App Server and LP origins by default", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890"
    });

    expect(config.allowedOrigins).toContain("https://api.mentor-code.ginjiro.homes");
    expect(config.allowedOrigins).toContain("https://mentor-code.ginjiro.homes");
  });

  it("allows overriding the app server log file path", () => {
    const config = new AppServerConfigLoader().fromEnv({
      MENTOR_SERVER_TOKEN: "test-local-token-1234567890",
      MENTOR_APP_SERVER_LOG_FILE: "C:\\logs\\mentor-code-app-server.log"
    });

    expect(config.logFilePath).toBe("C:\\logs\\mentor-code-app-server.log");
  });
});
