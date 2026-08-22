export const DEFAULT_APP_SERVER_URL = "https://api.mentor-code.ginjiro.homes";

export function normalizeAppServerUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_APP_SERVER_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("App Server URLはhttpまたはhttpsの絶対URLを指定してください。");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("App Server URLはhttpまたはhttpsで始まる必要があります。");
  }

  if (parsed.username || parsed.password) {
    throw new Error("App Server URLに認証情報を含めないでください。");
  }

  parsed.hash = "";
  parsed.search = "";

  return parsed.toString().replace(/\/$/, "");
}
