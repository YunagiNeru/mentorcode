import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentorSseStream } from "../src/server/http/mentorSseStream";

describe("MentorSseStream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends heartbeats without extending or fabricating progress events", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let ended = false;
    const response = {
      writableEnded: false,
      destroyed: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((value: string) => {
        writes.push(value);
        return true;
      }),
      end: vi.fn(() => {
        ended = true;
      })
    } as unknown as ServerResponse;
    const stream = new MentorSseStream(response, "req_abcdefghijklmnopabcdefghijklmnop");

    stream.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(writes).toEqual([": heartbeat\n\n"]);
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    }));

    stream.complete({
      response: { title: "ok", sections: [], policyWarnings: [] },
      safety: "ok"
    });
    const countAfterComplete = writes.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(ended).toBe(true);
    expect(writes).toHaveLength(countAfterComplete);
    expect(writes.at(-1)).toContain("event: result");
  });
});
