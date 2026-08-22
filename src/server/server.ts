import { AppServerConfigLoader } from "./config";
import { AppServer } from "./http/appServer";

async function main(): Promise<void> {
  const config = new AppServerConfigLoader().fromEnv();
  const server = new AppServer(config);
  const port = await server.listen();
  const shutdown = (): void => { void server.close().finally(() => { process.exitCode = 0; }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`Mentor Code app server listening on http://${config.host}:${port}`);
  console.log(`LLM mode: ${config.llmMode}`);
  console.log(`OpenAI model: ${config.openAiModel}`);
  console.log(`OpenAI reasoning effort: ${config.openAiReasoningEffort ?? "provider default"}`);
  console.log(`OpenAI API key configured: ${config.openAiApiKey ? "yes" : "no"}`);
  console.log(`Gemini model: ${config.geminiModel}`);
  console.log(`Gemini thinking level: ${config.geminiThinkingLevel ?? "provider default"}`);
  console.log(`Gemini thinking budget: ${config.geminiThinkingBudget ?? "provider default"}`);
  console.log(`Gemini fallback model configured: ${config.geminiFallbackModel ? "yes" : "no"}`);
  console.log(`Gemini fallback thinking level: ${config.geminiFallbackThinkingLevel ?? "primary/default"}`);
  console.log(`Gemini fallback thinking budget: ${config.geminiFallbackThinkingBudget ?? "primary/default"}`);
  console.log(`Gemini API key configured: ${config.geminiApiKey ? "yes" : "no"}`);
  console.log(`External LLM max calls: ${config.llmMaxCalls}`);
  console.log(`External LLM max transport retries: ${config.llmMaxTransportRetries}`);
  console.log(`External LLM attempt timeout: ${config.llmAttemptTimeoutMs} ms`);
  console.log(`External LLM total timeout: ${config.llmTotalTimeoutMs} ms`);
  console.log(`External LLM circuit threshold: ${config.llmCircuitFailureThreshold}`);
  console.log(`External LLM circuit open duration: ${config.llmCircuitOpenMs} ms`);
  console.log(`External LLM max concurrent requests: ${config.llmMaxConcurrentRequests}`);
  console.log(`Mentor event streaming enabled: ${config.mentorStreamingEnabled ? "yes" : "no"}`);
  console.log(`Skills execution enabled: ${config.skillsExecutionEnabled ? "yes" : "no"}`);
  console.log(`MCP Tools enabled: ${config.mcpToolsEnabled ? "yes" : "no"}`);
  console.log("Server safety recheck: mechanical");
  console.log(`Required client version: ${config.requiredClientVersion ?? "disabled"}`);
  console.log(`Client update URL: ${config.clientUpdateUrl}`);
  console.log(`App Server log file: ${config.logFilePath ?? "disabled"}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
