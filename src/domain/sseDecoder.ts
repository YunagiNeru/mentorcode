export interface SseFrame {
  readonly event?: string;
  readonly id?: string;
  readonly data: string;
}

export class SseEventDecoder {
  private buffer = "";

  public feed(chunk: string): readonly SseFrame[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  public finish(): readonly SseFrame[] {
    return this.drain(true);
  }

  private drain(flushRemainder: boolean): readonly SseFrame[] {
    const normalized = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized.split("\n\n");
    if (flushRemainder) {
      this.buffer = "";
    } else {
      this.buffer = blocks.pop() ?? "";
    }

    return blocks
      .map((block) => this.parseBlock(block))
      .filter((frame): frame is SseFrame => frame !== undefined);
  }

  private parseBlock(block: string): SseFrame | undefined {
    let event: string | undefined;
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) {
        continue;
      }
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

      if (field === "event") {
        event = value;
      } else if (field === "id") {
        id = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (dataLines.length === 0) {
      return undefined;
    }
    return {
      ...(event === undefined ? {} : { event }),
      ...(id === undefined ? {} : { id }),
      data: dataLines.join("\n")
    };
  }
}
