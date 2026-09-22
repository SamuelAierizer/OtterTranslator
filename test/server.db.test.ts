import { test } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { initDb, closeDb, getDb } from '../src/server/db.ts';

test('database setup', async () => {
  const testDb = path.join(os.tmpdir(), `otter-test-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();
  assert.ok(db, 'Database initialized');

  // Test create user
  const userId = randomUUID();
  const email = 'test@example.com';
  await db.run('INSERT INTO users (id, email) VALUES (?, ?)', [userId, email]);

  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  assert.strictEqual(user?.id, userId);
  assert.strictEqual(user?.email, email);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('database job insert and query', async () => {
  const testDb = path.join(os.tmpdir(), `otter-test-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();

  const userId = randomUUID();
  const jobId = randomUUID();

  // Create user
  await db.run('INSERT INTO users (id, email) VALUES (?, ?)', [userId, 'user@test.com']);

  // Create job
  await db.run(
    `INSERT INTO jobs (id, user_id, input_filename, from_lang, to_lang, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`,
    [jobId, userId, 'test.docx', 'en', 'es']
  );

  const job = await db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  assert.strictEqual(job?.id, jobId);
  assert.strictEqual(job?.status, 'queued');

  // Update job status
  await db.run('UPDATE jobs SET status = ? WHERE id = ?', ['running', jobId]);

  const updated = await db.get('SELECT * FROM jobs WHERE id = ?', [jobId]);
  assert.strictEqual(updated?.status, 'running');

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('database quota tracking', async () => {
  const testDb = path.join(os.tmpdir(), `otter-test-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();

  const quotaId = randomUUID();
  const provider = 'google';
  const month = '2024-01';

  // Insert quota
  await db.run(
    `INSERT INTO quota_usage (id, provider, month, characters_used)
     VALUES (?, ?, ?, ?)`,
    [quotaId, provider, month, 5000]
  );

  const quota = await db.get('SELECT * FROM quota_usage WHERE id = ?', [quotaId]);
  assert.strictEqual(quota?.characters_used, 5000);

  // Update quota
  await db.run('UPDATE quota_usage SET characters_used = ? WHERE id = ?', [7000, quotaId]);

  const updated = await db.get('SELECT * FROM quota_usage WHERE id = ?', [quotaId]);
  assert.strictEqual(updated?.characters_used, 7000);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});
