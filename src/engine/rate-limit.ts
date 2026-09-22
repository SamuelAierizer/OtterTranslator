/**
 * Token-bucket rate limiter with serialized queue.
 * Single worker — all requests pass through a queue, token bucket controls timing.
 */

export interface RateLimiterConfig {
  tokensPerSecond: number;
  maxBurst?: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly tokensPerSecond: number;
  private readonly maxBurst: number;
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(config: RateLimiterConfig) {
    this.tokensPerSecond = config.tokensPerSecond;
    this.maxBurst = config.maxBurst ?? config.tokensPerSecond;
    this.tokens = this.maxBurst;
    this.lastRefill = Date.now();
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsed * this.tokensPerSecond;
    this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async acquire(tokens: number = 1): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        while (true) {
          this.refillTokens();
          if (this.tokens >= tokens) {
            this.tokens -= tokens;
            resolve();
            return;
          }
          const tokensNeeded = tokens - this.tokens;
          const waitTime = (tokensNeeded / this.tokensPerSecond) * 1000;
          await new Promise((r) => setTimeout(r, waitTime));
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
      }
    }

    this.processing = false;
  }
}
