import { test } from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { initDb, closeDb } from '../src/server/db.ts';
import {
  isEmailAllowed,
  createMagicToken,
  verifyMagicToken,
  createSession,
  getSessionUser,
} from '../src/server/auth.ts';

test('auth: email allowed check', async () => {
  process.env.EMAIL_ALLOWLIST = 'allowed@example.com,test@example.com';

  const allowed = await isEmailAllowed('allowed@example.com');
  const notAllowed = await isEmailAllowed('denied@example.com');

  assert.strictEqual(allowed, true);
  assert.strictEqual(notAllowed, false);
});

test('auth: magic token single-use enforcement', async () => {
  const testDb = path.join(os.tmpdir(), `otter-auth-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;
  process.env.EMAIL_ALLOWLIST = 'test@example.com';

  const db = await initDb();

  const email = 'test@example.com';
  const token = await createMagicToken(email);

  // First use should succeed
  const user1 = await verifyMagicToken(token);
  assert.ok(user1, 'First verification should succeed');
  assert.strictEqual(user1.email, email);

  // Second use should fail
  const user2 = await verifyMagicToken(token);
  assert.strictEqual(user2, null, 'Second verification should fail');

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('auth: magic token expiration', async () => {
  const testDb = path.join(os.tmpdir(), `otter-auth-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;
  process.env.EMAIL_ALLOWLIST = 'test@example.com';

  const db = await initDb();

  // Manually insert an expired token
  const email = 'test@example.com';
  const expiredToken = 'expired-token-12345';
  const pastDate = new Date(Date.now() - 1000 * 60 * 60).toISOString();

  await db.run(
    `INSERT INTO magic_tokens (id, email, token, expires_at)
     VALUES (?, ?, ?, ?)`,
    ['expired-id', email, expiredToken, pastDate]
  );

  // Verify should fail for expired token
  const user = await verifyMagicToken(expiredToken);
  assert.strictEqual(user, null, 'Expired token should not verify');

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('auth: session creation and validation', async () => {
  const testDb = path.join(os.tmpdir(), `otter-auth-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;
  process.env.EMAIL_ALLOWLIST = 'test@example.com';

  const db = await initDb();

  // Create user via magic token
  const email = 'test@example.com';
  const magicToken = await createMagicToken(email);
  const user = await verifyMagicToken(magicToken);
  assert.ok(user, 'User created from magic token');

  // Create session
  const sessionToken = await createSession(user.id);
  assert.ok(sessionToken, 'Session token created');

  // Verify session
  const sessionUser = await getSessionUser(sessionToken);
  assert.ok(sessionUser, 'Session user retrieved');
  assert.strictEqual(sessionUser.id, user.id);
  assert.strictEqual(sessionUser.email, email);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});

test('auth: invalid session token returns null', async () => {
  const testDb = path.join(os.tmpdir(), `otter-auth-${randomUUID()}.db`);
  process.env.DB_PATH = testDb;

  const db = await initDb();

  const user = await getSessionUser('invalid-token-12345');
  assert.strictEqual(user, null);

  await closeDb();
  await fs.unlink(testDb).catch(() => {});
});
