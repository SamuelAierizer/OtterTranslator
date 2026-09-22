import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { initDb, closeDb } from '../src/server/db.ts';
import { SqliteQuotaStore } from '../src/server/quota.ts';

test('quota: check and increment passes when under limit', async () => {
  const testDb = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();
  const store = new SqliteQuotaStore();

  const canProceed = await store.checkAndIncrement('google', '2024-01', 1000, 100000);
  assert.strictEqual(canProceed, true);

  const usage = await store.getUsage('google', '2024-01');
  assert.strictEqual(usage, 1000);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('quota: check and increment fails when over limit', async () => {
  const testDb = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();
  const store = new SqliteQuotaStore();

  await store.checkAndIncrement('google', '2024-01', 80000, 100000);

  const canProceed = await store.checkAndIncrement('google', '2024-01', 30000, 100000);
  assert.strictEqual(canProceed, false);

  const usage = await store.getUsage('google', '2024-01');
  assert.strictEqual(usage, 80000);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('quota: track per user quota', async () => {
  const testDb = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();
  const store = new SqliteQuotaStore();

  const userId1 = 'user-1';
  const userId2 = 'user-2';

  await store.checkAndIncrement('google', '2024-01', 5000, 10000, userId1);
  await store.checkAndIncrement('google', '2024-01', 3000, 10000, userId2);

  const usage1 = await store.getUsage('google', '2024-01', userId1);
  const usage2 = await store.getUsage('google', '2024-01', userId2);

  assert.strictEqual(usage1, 5000);
  assert.strictEqual(usage2, 3000);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('quota: reset clears usage', async () => {
  const testDb = path.join(os.tmpdir(), `otter-quota-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();
  const store = new SqliteQuotaStore();

  await store.checkAndIncrement('google', '2024-01', 5000, 10000);
  await store.reset('google', '2024-01');

  const usage = await store.getUsage('google', '2024-01');
  assert.strictEqual(usage, 0);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});
