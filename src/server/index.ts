import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import { promises as fs } from 'fs';
import { createReadStream } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { initDb, getDb, closeDb } from './db.js';
import { SqliteQuotaStore } from './quota.js';
import { JobQueue } from './queue.js';
import {
  isEmailAllowed,
  createMagicToken,
  verifyMagicToken,
  createSession,
  getSessionUser,
  deleteExpiredTokens,
} from './auth.js';
import { validateUpload } from './guards.js';
import { PROVIDER_LIMITS } from '../engine/backends/index.js';
import { currentMonth } from '../engine/quota.js';
import type { Job } from './types.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/outputs';

/**
 * Builds the configured server without listening or touching the filesystem beyond the output
 * directory, so tests and tooling can import this module. Side effects belong in `main()`.
 */
export async function buildServer() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const app = Fastify({ logger: true });
  const quotaStore = new SqliteQuotaStore();
  const jobQueue = new JobQueue(quotaStore);

  await app.register(fastifyMultipart);
  await app.register(fastifyCookie);

  await initDb();

  // Routes

  app.get('/healthz', async (req, reply) => {
    const db = getDb();
    const queuedCount = await db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM jobs WHERE status = 'queued'`,
    );

    const month = currentMonth();
    const quota: Record<string, { used: number; limit: number; remaining: number }> = {};
    for (const [provider, limit] of Object.entries(PROVIDER_LIMITS)) {
      const used = await quotaStore.getUsage(provider, month);
      quota[provider] = { used, limit, remaining: Math.max(0, limit - used) };
    }

    return {
      status: 'ok',
      queue_depth: queuedCount?.count || 0,
      month,
      quota,
    };
  });

  app.post<{ Body: { email: string } }>('/api/auth/request', async (req, reply) => {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return reply.status(400).send({ error: 'Email required' });
    }

    if (!(await isEmailAllowed(email))) {
      return reply.status(403).send({ error: 'Email not allowed' });
    }

    try {
      const token = await createMagicToken(email);
      const magicLink = `${process.env.ORIGIN || 'http://localhost:3000'}/auth/verify?token=${token}`;

      // TODO: Send email via nodemailer
      console.log(`Magic link for ${email}: ${magicLink}`);

      return { status: 'ok', message: 'Check your email for a magic link' };
    } catch (err) {
      console.error('Auth request error:', err);
      return reply.status(500).send({ error: 'Failed to create token' });
    }
  });

  app.get<{ Querystring: { token: string } }>('/auth/verify', async (req, reply) => {
    const { token } = req.query;

    if (!token) {
      return reply.status(400).send({ error: 'Token required' });
    }

    try {
      const user = await verifyMagicToken(token);
      if (!user) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }

      const sessionToken = await createSession(user.id);
      reply.setCookie('session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      return reply.redirect('/');
    } catch (err) {
      console.error('Verify error:', err);
      return reply.status(500).send({ error: 'Verification failed' });
    }
  });

  app.post('/api/upload', async (req, reply) => {
    const sessionToken = req.cookies.session;
    if (!sessionToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const user = await getSessionUser(sessionToken);
    if (!user) {
      return reply.status(401).send({ error: 'Session expired' });
    }

    try {
      const data = await req.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file provided' });
      }

      const buffer = await data.toBuffer();
      await validateUpload(buffer);

      let fromLang = 'en';
      let toLang = 'es';

      // Process multipart fields
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'from') {
          fromLang = (part.value as string) || 'en';
        } else if (part.type === 'field' && part.fieldname === 'to') {
          toLang = (part.value as string) || 'es';
        }
      }

      const jobId = randomUUID();
      const inputFilename = `${jobId}-input.docx`;
      const inputPath = path.join(OUTPUT_DIR, inputFilename);
      await fs.writeFile(inputPath, buffer);

      const db = getDb();
      await db.run(
        `INSERT INTO jobs (id, user_id, input_filename, from_lang, to_lang) VALUES (?, ?, ?, ?, ?)`,
        [jobId, user.id, inputFilename, fromLang, toLang],
      );

      return { id: jobId, status: 'queued' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return reply.status(400).send({ error: message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const sessionToken = req.cookies.session;
    if (!sessionToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const user = await getSessionUser(sessionToken);
    if (!user) {
      return reply.status(401).send({ error: 'Session expired' });
    }

    try {
      const db = getDb();
      const job = await db.get<Job>(`SELECT * FROM jobs WHERE id = ? AND user_id = ?`, [
        req.params.id,
        user.id,
      ]);

      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      return job;
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to fetch job' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/download/:id', async (req, reply) => {
    const sessionToken = req.cookies.session;
    if (!sessionToken) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const user = await getSessionUser(sessionToken);
    if (!user) {
      return reply.status(401).send({ error: 'Session expired' });
    }

    try {
      const db = getDb();
      const job = await db.get<Job>(
        `SELECT * FROM jobs WHERE id = ? AND user_id = ? AND status = 'done'`,
        [req.params.id, user.id],
      );

      if (!job || !job.output_filename) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const filePath = path.join(OUTPUT_DIR, job.output_filename);
      reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      reply.header('Content-Disposition', `attachment; filename="translated.docx"`);
      return reply.send(createReadStream(filePath));
    } catch (err) {
      return reply.status(500).send({ error: 'Download failed' });
    }
  });

  // Cleanup timers
  const tokenTimer = setInterval(
    () => {
      deleteExpiredTokens().catch(console.error);
    },
    60 * 60 * 1000,
  );

  const purgeTimer = setInterval(() => purgeExpiredOutputs().catch(console.error), 60 * 60 * 1000);

  await jobQueue.start();

  const close = async () => {
    clearInterval(tokenTimer);
    clearInterval(purgeTimer);
    await jobQueue.stop();
    await app.close();
    await closeDb();
  };

  return { app, jobQueue, quotaStore, close };
}

/**
 * Deletes outputs older than the 24 h retention window, file first and then the DB row, so a
 * purge that dies halfway never leaves a job pointing at a file that is gone.
 */
export async function purgeExpiredOutputs(): Promise<number> {
  const db = getDb();
  // ISO-8601 on both sides. `completed_at` is written as ISO by the queue; comparing it against
  // SQLite's own datetime('now') format would mis-sort within the same day, because its space
  // separator sorts below 'T' — every job completed today would look older than the cutoff.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const oldJobs = await db.all<{ id: string; output_filename: string | null }>(
    `SELECT id, output_filename FROM jobs WHERE status = 'done' AND completed_at < ?`,
    [cutoff],
  );

  for (const job of oldJobs) {
    if (job.output_filename) {
      await fs.unlink(path.join(OUTPUT_DIR, job.output_filename)).catch(() => {});
    }
  }

  await db.run(`DELETE FROM jobs WHERE status = 'done' AND completed_at < ?`, [cutoff]);
  return oldJobs.length;
}

async function main(): Promise<void> {
  const { app, close } = await buildServer();

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await close();
    process.exit(0);
  });

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start when run directly, so importing this module (tests, tooling) has no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
