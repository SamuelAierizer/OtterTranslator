import { randomUUID } from 'crypto';
import { getDb } from './db.js';
import type { QuotaStore } from './types.js';

export class SqliteQuotaStore implements QuotaStore {
  async checkAndIncrement(
    provider: string,
    month: string,
    characters: number,
    limit: number,
    userId?: string
  ): Promise<boolean> {
    const db = getDb();
    const id = randomUUID();

    const existing = await db.get<{ characters_used: number }>(
      `SELECT characters_used FROM quota_usage
       WHERE provider = ? AND month = ? AND user_id IS ?`,
      [provider, month, userId || null]
    );

    const currentUsage = existing?.characters_used || 0;
    const newUsage = currentUsage + characters;

    if (newUsage > limit) {
      return false;
    }

    if (existing) {
      await db.run(
        `UPDATE quota_usage SET characters_used = ? WHERE provider = ? AND month = ? AND user_id IS ?`,
        [newUsage, provider, month, userId || null]
      );
    } else {
      await db.run(
        `INSERT INTO quota_usage (id, provider, user_id, month, characters_used)
         VALUES (?, ?, ?, ?, ?)`,
        [id, provider, userId || null, month, characters]
      );
    }

    return true;
  }

  async getUsage(provider: string, month: string, userId?: string): Promise<number> {
    const db = getDb();
    const result = await db.get<{ characters_used: number }>(
      `SELECT characters_used FROM quota_usage
       WHERE provider = ? AND month = ? AND user_id IS ?`,
      [provider, month, userId || null]
    );
    return result?.characters_used || 0;
  }

  async reset(provider: string, month: string): Promise<void> {
    const db = getDb();
    await db.run(
      `DELETE FROM quota_usage WHERE provider = ? AND month = ?`,
      [provider, month]
    );
  }
}
