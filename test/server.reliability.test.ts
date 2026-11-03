import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer, purgeExpiredOutputs } from '../src/server/index.js';
import { getDb } from '../src/server/db.js';
import { createMagicToken, verifyMagicToken } from '../src/server/auth.js';
import { JobQueue } from '../src/server/queue.js';
import type { Job } from '../src/server/types.js';

async function createFixture(): Promise<{ directory: string; server: Awaited<ReturnType<typeof buildServer>>; userId: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'otter-reliability-'));
  Object.assign(process.env, {
    DB_PATH: path.join(directory, 'app.db'),
    OUTPUT_DIR: path.join(directory, 'files'),
    EMAIL_ALLOWLIST: 'review@example.com',
    ORIGIN: 'http://localhost:3000',
  });
  const server = await buildServer({ worker: false, logger: false });
  const user = await verifyMagicToken(await createMagicToken('review@example.com'));
  assert.ok(user);
  return { directory, server, userId: user.id };
}

async function insertJob(id: string, userId: string, createdAt: string): Promise<void> {
  await getDb().run(
    'INSERT INTO jobs (id,user_id,input_filename,from_lang,to_lang,created_at) VALUES (?,?,?,?,?,?)',
    [id, userId, `${id}-input.docx`, 'en', 'ro', createdAt],
  );
}

async function waitForJob(id: string, status: Job['status']): Promise<Job> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await getDb().get<Job>('SELECT * FROM jobs WHERE id=?', [id]);
    if (job?.status === status) return job;
    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 10); });
  }
  throw new Error(`Job ${id} did not reach ${status}`);
}

test('a failed progress write is handled immediately and fails only its job', async (): Promise<void> => {
  const { directory, server, userId } = await createFixture();
  let queue: JobQueue | undefined;
  try {
    await insertJob('progress', userId, new Date().toISOString());
    await writeFile(path.join(directory, 'files', 'progress-input.docx'), 'input');
    await getDb().exec(`CREATE TRIGGER reject_progress BEFORE UPDATE OF stage ON jobs
      WHEN NEW.stage='translating' BEGIN SELECT RAISE(FAIL,'progress storage unavailable'); END`);
    queue = new JobQueue(server.quotaStore, path.join(directory, 'files'), async (_buffer, options): Promise<Buffer> => {
      options.onStage?.('translating', 50);
      // Keep the provider in flight past the failed write. The old implementation
      // emits an unhandled rejection here, which node:test treats as a failure.
      await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 40); });
      return Buffer.from('output');
    });
    await queue.start();
    const job = await waitForJob('progress', 'failed');
    assert.match(job.error_message || '', /progress storage unavailable/);
    assert.equal((await server.app.inject('/healthz')).statusCode, 200);
    await assert.rejects(readFile(path.join(directory, 'files', 'progress.docx')), { code: 'ENOENT' });
  } finally {
    await queue?.stop();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup tolerates an undeletable expired artifact and cleanup continues and retries', async (): Promise<void> => {
  const fixture = await createFixture();
  let server = fixture.server;
  try {
    await insertJob('blocked', fixture.userId, '2000-01-01');
    await insertJob('deletable', fixture.userId, '2000-01-01');
    await mkdir(path.join(fixture.directory, 'files', 'blocked-input.docx'));
    await writeFile(path.join(fixture.directory, 'files', 'deletable-input.docx'), 'old input');
    await server.close();
    server = await buildServer({ worker: false, logger: false });
    assert.equal((await server.app.inject('/healthz')).statusCode, 200);
    assert.ok(await getDb().get("SELECT id FROM jobs WHERE id='blocked'"));
    assert.equal(await getDb().get("SELECT id FROM jobs WHERE id='deletable'"), undefined);
    await rm(path.join(fixture.directory, 'files', 'blocked-input.docx'), { recursive: true });
    assert.equal(await purgeExpiredOutputs(), 1);
    assert.equal(await getDb().get("SELECT id FROM jobs WHERE id='blocked'"), undefined);
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('expired queued jobs never reach translation while fresh jobs still complete', async (): Promise<void> => {
  const { directory, server, userId } = await createFixture();
  let queue: JobQueue | undefined;
  try {
    await insertJob('expired', userId, '2000-01-01');
    await insertJob('fresh', userId, new Date().toISOString());
    await writeFile(path.join(directory, 'files', 'expired-input.docx'), 'expired');
    await writeFile(path.join(directory, 'files', 'fresh-input.docx'), 'fresh');
    const translated: string[] = [];
    queue = new JobQueue(server.quotaStore, path.join(directory, 'files'), async (buffer: Buffer): Promise<Buffer> => {
      translated.push(buffer.toString());
      return buffer;
    });
    await queue.start();
    await waitForJob('fresh', 'done');
    await queue.stop();
    assert.deepEqual(translated, ['fresh']);
    assert.equal(await purgeExpiredOutputs(), 1);
    await assert.rejects(readFile(path.join(directory, 'files', 'expired-input.docx')), { code: 'ENOENT' });
  } finally {
    await queue?.stop();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent sign-in requests atomically admit three emails per fifteen minutes', async (): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'otter-mail-limit-'));
  Object.assign(process.env, { DB_PATH: path.join(directory, 'app.db'), OUTPUT_DIR: path.join(directory, 'files'), EMAIL_ALLOWLIST: 'review@example.com', ORIGIN: 'http://localhost:3000' });
  let emailsSent = 0;
  const server = await buildServer({ worker: false, logger: false, sendMagicLink: async (): Promise<void> => { emailsSent++; } });
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => server.app.inject({ method: 'POST', url: '/api/auth/request', payload: { email: ' REVIEW@example.com ' } })));
    assert.equal(responses.filter(response => response.statusCode === 200).length, 3);
    assert.equal(responses.filter(response => response.statusCode === 429).length, 5);
    assert.equal(emailsSent, 3);
    assert.equal((await getDb().all('SELECT * FROM magic_tokens')).length, 3);
    await getDb().run("UPDATE magic_tokens SET created_at=datetime('now','-16 minutes')");
    const next = await server.app.inject({ method: 'POST', url: '/api/auth/request', payload: { email: 'review@example.com' } });
    assert.equal(next.statusCode, 200);
    assert.equal(emailsSent, 4);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
