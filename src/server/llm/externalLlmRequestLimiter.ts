export type ExternalLlmRequestRelease = () => void;

export class ExternalLlmRequestLimiter {
  private activeRequests = 0;

  public constructor(private readonly maximumConcurrentRequests: number) {}

  public tryAcquire(): ExternalLlmRequestRelease | undefined {
    if (this.activeRequests >= this.maximumConcurrentRequests) {
      return undefined;
    }

    this.activeRequests += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeRequests -= 1;
    };
  }
}
