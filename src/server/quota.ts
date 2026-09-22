import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import type { QuotaStore } from '../engine/types.js';

/**
 * The engine's `QuotaStore` backed by the `quota_usage` table on the persistent volume.
 *
 * This is the only reason the free tier stays free across restarts: an in-memory counter resets
 * with the container and silently overruns the providers' monthly budgets. Losing the /data volume
 * loses these counters and has the same effect.
 */
export class SqliteQuotaStore implements QuotaStore {
  async getUsage(provider: string, month: string): Promise<number> {
    const db = getDb();
    const row = await db.get<{ characters_used: number }>(
      `SELECT characters_used FROM quota_usage WHERE provider = ? AND month = ?`,
      [provider, month]
    );
    return row?.characters_used || 0;
  }

  async addUsage(provider: string, month: string, characters: number): Promise<void> {
    const db = getDb();
    // Single statement so a concurrent reader can never observe a lost update; the UNIQUE index on
    // (provider, month) is what makes the upsert resolve to an increment.
    await db.run(
      `INSERT INTO quota_usage (id, provider, month, characters_used) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider, month)
       DO UPDATE SET characters_used = characters_used + excluded.characters_used`,
      [randomUUID(), provider, month, characters]
    );
  }

  /** Clears a month's usage. Present for tests and for manual correction after a provider dispute. */
  async reset(provider: string, month: string): Promise<void> {
    const db = getDb();
    await db.run(`DELETE FROM quota_usage WHERE provider = ? AND month = ?`, [provider, month]);
  }
}
