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

/** Character-weighted sliding window shared by requests, including retries. */
export class CharacterRateLimiter {
  private entries: Array<{ at: number; chars: number }> = [];
  private head = 0;
  private used = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private limit = 33_000,
    private windowMs = 60_000,
    private now: () => number = Date.now,
    private wait: (ms: number, signal?: AbortSignal) => Promise<void> = async (ms, signal) => {
      const { setTimeout } = await import('node:timers/promises');
      await setTimeout(ms, undefined, { signal });
    }
  ) {}
  acquire(chars: number, signal?: AbortSignal): Promise<void> {
    if (chars > this.limit || chars < 0) return Promise.reject(new Error('Request exceeds character rate window'));
    const task = this.pending.then(async () => {
      while (true) {
        signal?.throwIfAborted();
        const now = this.now();
        while (this.head < this.entries.length && this.entries[this.head].at <= now - this.windowMs) this.used -= this.entries[this.head++].chars;
        if (this.used + chars <= this.limit) {
          if (this.head > 1024) { this.entries = this.entries.slice(this.head); this.head = 0; }
          this.entries.push({ at: now, chars }); this.used += chars; return;
        }
        await this.wait(this.entries[this.head].at + this.windowMs - now, signal);
      }
    });
    this.pending = task.catch(() => {});
    return task;
  }
}
