/**
 * Free-tier character accounting.
 *
 * The providers' free tiers are monthly character budgets, so overrunning one is a billing event
 * rather than a glitch. The engine therefore never owns the counter: it reads and writes through a
 * `QuotaStore` the caller injects, so the server can persist it in SQLite and survive a restart.
 * The month key is recomputed on every operation, which is also what makes the monthly reset
 * automatic — there is no rollover bookkeeping to get wrong.
 */

import { QuotaExhaustedError } from './errors.js';
import type { QuotaStore } from './types.js';

/** Calendar-month key, e.g. "2026-09". Usage is bucketed by this, matching the providers' reset. */
export function currentMonth(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * In-memory fallback for the CLI.
 *
 * NOTE: this resets on every process start. A long-running service using it would silently overrun
 * the providers' free tiers — the server must inject a persistent store instead.
 */
export class InMemoryQuotaStore implements QuotaStore {
  private usage = new Map<string, number>();

  private key(provider: string, month: string): string {
    return `${provider}:${month}`;
  }

  async getUsage(provider: string, month: string): Promise<number> {
    return this.usage.get(this.key(provider, month)) ?? 0;
  }

  async addUsage(provider: string, month: string, characters: number): Promise<void> {
    const key = this.key(provider, month);
    this.usage.set(key, (this.usage.get(key) ?? 0) + characters);
  }
}

/**
 * One provider's slice of a quota store: checks a request against the remaining monthly budget and
 * records what was actually spent.
 *
 * Charging happens after a request succeeds, never before, so a failed or partially-failed request
 * cannot double-count against the budget.
 */
export class QuotaLedger {
  constructor(
    private readonly provider: string,
    private readonly limit: number,
    private readonly store: QuotaStore
  ) {}

  async remaining(): Promise<number> {
    const used = await this.store.getUsage(this.provider, currentMonth());
    return Math.max(0, this.limit - used);
  }

  /** Throws `QuotaExhaustedError` if `characters` would not fit in this month's remaining budget. */
  async assertAvailable(characters: number): Promise<void> {
    const remaining = await this.remaining();
    if (characters > remaining) {
      throw new QuotaExhaustedError(
        `${this.provider} quota exhausted: need ${characters} characters, ${remaining} remain this month`
      );
    }
  }

  /** Records characters actually sent. Call only after the provider accepted the request. */
  async charge(characters: number): Promise<void> {
    if (characters <= 0) return;
    await this.store.addUsage(this.provider, currentMonth(), characters);
  }
}
