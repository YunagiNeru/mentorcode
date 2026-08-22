import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SERVER_URL, normalizeAppServerUrl } from "../src/domain/appServerUrl";

describe("normalizeAppServerUrl", () => {
  it("uses the public App Server URL by default", () => {
    expect(normalizeAppServerUrl(undefined)).toBe(DEFAULT_APP_SERVER_URL);
    expect(normalizeAppServerUrl("")).toBe(DEFAULT_APP_SERVER_URL);
  });

  it("keeps http and https URLs while removing trailing slash, query, and hash", () => {
    expect(normalizeAppServerUrl("https://api.mentor-code.ginjiro.homes/")).toBe("https://api.mentor-code.ginjiro.homes");
    expect(normalizeAppServerUrl("http://127.0.0.1:8787/?x=1#top")).toBe("http://127.0.0.1:8787");
  });

  it("rejects malformed URLs, unsupported protocols, and embedded credentials", () => {
    expect(() => normalizeAppServerUrl("api.mentor-code.ginjiro.homes")).toThrow("App Server URLはhttpまたはhttpsの絶対URLを指定してください。");
    expect(() => normalizeAppServerUrl("file:///tmp/server")).toThrow("App Server URLはhttpまたはhttpsで始まる必要があります。");
    expect(() => normalizeAppServerUrl("https://user:pass@api.mentor-code.ginjiro.homes")).toThrow("App Server URLに認証情報を含めないでください。");
  });
});
