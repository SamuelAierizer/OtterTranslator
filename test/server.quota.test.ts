import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { initDb, closeDb } from '../src/server/db.ts';
import { SqliteQuotaStore } from '../src/server/quota.ts';
import { QuotaLedger, currentMonth } from '../src/engine/quota.ts';
import { QuotaExhaustedError } from '../src/engine/errors.ts';

async function withTempDb<T>(fn: (store: SqliteQuotaStore, dbPath: string) => Promise<T>): Promise<T> {
  const dbPath = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = dbPath;
  await initDb();
  try {
    return await fn(new SqliteQuotaStore(), dbPath);
  } finally {
    await closeDb();
    await fs.unlink(dbPath).catch(() => {});
  }
}

test('quota: usage accumulates per provider and month', async () => {
  await withTempDb(async (store) => {
    await store.addUsage('microsoft-translator', '2026-09', 1000);
    await store.addUsage('microsoft-translator', '2026-09', 500);
    await store.addUsage('google-cloud', '2026-09', 200);

    assert.strictEqual(await store.getUsage('microsoft-translator', '2026-09'), 1500);
    assert.strictEqual(await store.getUsage('google-cloud', '2026-09'), 200);
  });
});

test('quota: a new calendar month starts from zero', async () => {
  await withTempDb(async (store) => {
    await store.addUsage('microsoft-translator', '2026-09', 1_999_999);

    assert.strictEqual(await store.getUsage('microsoft-translator', '2026-10'), 0);
    assert.strictEqual(await store.getUsage('microsoft-translator', '2026-09'), 1_999_999);
  });
});

test('quota: counters survive a restart', async () => {
  const dbPath = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = dbPath;

  try {
    await initDb();
    await new SqliteQuotaStore().addUsage('microsoft-translator', '2026-09', 12_345);
    await closeDb();

    // Second "process": same file, fresh store instance.
    await initDb();
    const usage = await new SqliteQuotaStore().getUsage('microsoft-translator', '2026-09');
    assert.strictEqual(usage, 12_345, 'usage must not reset when the process restarts');
    await closeDb();
  } finally {
    await fs.unlink(dbPath).catch(() => {});
  }
});

test('quota: the ledger refuses a request that would exceed the monthly limit', async () => {
  await withTempDb(async (store) => {
    const ledger = new QuotaLedger('microsoft-translator', 1000, store);

    await ledger.assertAvailable(600);
    await ledger.charge(600);

    assert.strictEqual(await ledger.remaining(), 400);
    await assert.rejects(() => ledger.assertAvailable(401), QuotaExhaustedError);
    await ledger.assertAvailable(400);
  });
});

test('quota: the ledger charges the month it is called in', async () => {
  await withTempDb(async (store) => {
    await new QuotaLedger('google-cloud', 500_000, store).charge(700);
    assert.strictEqual(await store.getUsage('google-cloud', currentMonth()), 700);
  });
});

test('quota: reset clears a single provider-month', async () => {
  await withTempDb(async (store) => {
    await store.addUsage('google-cloud', '2026-09', 900);
    await store.addUsage('google-cloud', '2026-10', 100);

    await store.reset('google-cloud', '2026-09');

    assert.strictEqual(await store.getUsage('google-cloud', '2026-09'), 0);
    assert.strictEqual(await store.getUsage('google-cloud', '2026-10'), 100);
  });
});
