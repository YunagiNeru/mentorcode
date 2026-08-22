import { describe, expect, it } from "vitest";
import { SseEventDecoder } from "../src/domain/sseDecoder";

describe("SseEventDecoder", () => {
  it("分割されたチャンクからイベントを復元する", () => {
    const decoder = new SseEventDecoder();

    expect(decoder.feed("event: progre")).toEqual([]);
    expect(decoder.feed("ss\r\nid: 2\r\ndata: {\"type\":\"progress\"}\r\n\r\n")).toEqual([
      {
        event: "progress",
        id: "2",
        data: "{\"type\":\"progress\"}"
      }
    ]);
  });

  it("複数data行を改行で結合し、heartbeatコメントを無視する", () => {
    const decoder = new SseEventDecoder();

    expect(decoder.feed(": heartbeat\n\ndata: first\ndata: second\n\n")).toEqual([
      { data: "first\nsecond" }
    ]);
  });

  it("終端の空行がない最後のイベントをfinishで返す", () => {
    const decoder = new SseEventDecoder();

    expect(decoder.feed("event: result\ndata: done")).toEqual([]);
    expect(decoder.finish()).toEqual([{ event: "result", data: "done" }]);
    expect(decoder.finish()).toEqual([]);
  });
});
