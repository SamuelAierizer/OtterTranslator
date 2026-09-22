import { randomBytes, randomUUID } from 'crypto';
import { getDb } from './db.js';
import type { User, Session, MagicToken } from './types.js';

const TOKEN_EXPIRY_MINUTES = 15;
const SESSION_EXPIRY_DAYS = 30;

/**
 * Expiries are written as JS ISO-8601 ("2026-09-22T15:01:49.814Z"), so they must also be compared
 * against an ISO-8601 string. SQLite's own `datetime('now')` renders "2026-09-22 15:01:49", and
 * because ' ' sorts below 'T' the lexical comparison treats every stored expiry as still in the
 * future — expired tokens and sessions would all validate.
 */
function nowIso(): string {
  return new Date().toISOString();
}

function getAllowlist(): Set<string> {
  return new Set((process.env.EMAIL_ALLOWLIST || '').split(',').filter(Boolean));
}

export async function isEmailAllowed(email: string): Promise<boolean> {
  const allowlist = getAllowlist();
  if (allowlist.size === 0) return false;
  return allowlist.has(email.toLowerCase());
}

export async function createMagicToken(email: string): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY_MINUTES * 60 * 1000);

  await db.run(
    `INSERT INTO magic_tokens (id, email, token, expires_at) VALUES (?, ?, ?, ?)`,
    [id, email.toLowerCase(), token, expiresAt.toISOString()]
  );

  return token;
}

export async function verifyMagicToken(token: string): Promise<User | null> {
  const db = getDb();
  const magicToken = await db.get<MagicToken>(
    `SELECT * FROM magic_tokens WHERE token = ? AND used = 0 AND expires_at > ?`,
    [token, nowIso()]
  );

  if (!magicToken) {
    return null;
  }

  // Mark token as used
  await db.run(`UPDATE magic_tokens SET used = 1 WHERE id = ?`, [magicToken.id]);

  // Get or create user
  let user = await db.get<User>(`SELECT * FROM users WHERE email = ?`, [magicToken.email]);

  if (!user) {
    const userId = randomUUID();
    await db.run(`INSERT INTO users (id, email) VALUES (?, ?)`, [userId, magicToken.email]);
    user = { id: userId, email: magicToken.email, created_at: new Date().toISOString() };
  }

  return user;
}

export async function createSession(userId: string): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.run(
    `INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`,
    [id, userId, token, expiresAt.toISOString()]
  );

  return token;
}

export async function getSessionUser(token: string): Promise<User | null> {
  const db = getDb();
  const session = await db.get<Session>(
    `SELECT * FROM sessions WHERE token = ? AND expires_at > ?`,
    [token, nowIso()]
  );

  if (!session) {
    return null;
  }

  const user = await db.get<User>(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
  return user || null;
}

export async function deleteExpiredTokens(): Promise<void> {
  const db = getDb();
  const now = nowIso();
  await db.run(`DELETE FROM magic_tokens WHERE expires_at <= ?`, [now]);
  await db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [now]);
}
