import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import type { QuotaStore } from '../engine/types.js';

/**
 * The engine's `QuotaStore` backed by the `quota_usage` table on the persistent volume.
 *
 * Persistent reservations protect the application's monthly budget across restarts. Account-side
 * usage and billing controls remain necessary; see docs/providers.md. Losing /data loses counters.
 */
export class SqliteQuotaStore implements QuotaStore {
  async reserveUsage(provider: string, month: string, characters: number, limit: number): Promise<boolean> {
    const row = await getDb().get<{id: string}>(
      `INSERT INTO quota_usage (id,provider,month,characters_used) SELECT ?,?,?,? WHERE ?<=?
       ON CONFLICT(provider,month) DO UPDATE SET characters_used=characters_used+excluded.characters_used
       WHERE characters_used+excluded.characters_used<=? RETURNING id`,
      [randomUUID(),provider,month,characters,characters,limit,limit]);
    return Boolean(row);
  }
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
