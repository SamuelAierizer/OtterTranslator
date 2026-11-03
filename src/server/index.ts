import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import nodemailer from 'nodemailer';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { initDb, getDb, closeDb } from './db.js';
import { SqliteQuotaStore } from './quota.js';
import { JobQueue } from './queue.js';
import {
  isEmailAllowed,
  MagicLinkRateLimitError,
  createMagicToken,
  verifyMagicToken,
  createSession,
  getSessionUser,
  deleteExpiredTokens,
} from './auth.js';
import { validateUpload } from './guards.js';
import { page, clientScript } from './ui.js';
import { purgeExpiredOutputs } from './retention.js';
import type { Job, User } from './types.js';
export { purgeExpiredOutputs } from './retention.js';

/** Server dependencies and worker/logging switches, primarily for isolated tests. */
export interface ServerOptions {
  sendMagicLink?: (email: string, link: string) => Promise<void>;
  worker?: boolean;
  logger?: boolean;
}

/** Initialized server resources; close releases the SQLite connection owned by this instance. */
export interface OtterServer {
  app: FastifyInstance;
  jobQueue: JobQueue;
  quotaStore: SqliteQuotaStore;
  close: () => Promise<void>;
}

type AuthRequest = { Body: { email?: string } };
type VerifyRequest = { Querystring: { token?: string } };
type JobRequest = { Params: { id: string } };

/**
 * Initialize SQLite, routes, retention maintenance and the optional serial worker.
 * Does not listen. The caller owns this instance and must await close() to stop
 * maintenance, abort/drain translation work and release mail/SQLite resources.
 */
export async function buildServer(options: ServerOptions = {}): Promise<OtterServer> {
  const directory = process.env.OUTPUT_DIR || '/data/outputs';
  const origin = new URL(process.env.ORIGIN || 'http://localhost:3000').origin;
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) {
    throw new Error('Production ORIGIN must use HTTPS');
  }
  await fs.mkdir(directory, { recursive: true });
  await initDb();
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 3 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const quotaStore = new SqliteQuotaStore();
  const jobQueue = new JobQueue(quotaStore, directory);
  const smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  const send = options.sendMagicLink ?? (async (email: string, link: string): Promise<void> => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
      throw new Error('SMTP_HOST and SMTP_FROM are required');
    }
    await smtp.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Sign in to OtterTranslator',
      text: `Sign in using this single-use link (expires in 15 minutes):\n${link}\n\nIf you did not request this, ignore this email.`,
    });
  });

  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2, parts: 3, fieldSize: 64 },
  });
  await app.register(cookie);
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    reply.header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== origin) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
  });
  const userFor = async (req: FastifyRequest): Promise<User | null> =>
    req.cookies.session ? getSessionUser(req.cookies.session) : null;

  app.get('/', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> =>
    reply.type('text/html').send(page((await userFor(req))?.email)));
  app.get('/app.js', async (_req: FastifyRequest, reply: FastifyReply): Promise<unknown> =>
    reply.type('application/javascript').send(clientScript));
  app.get('/healthz', async (): Promise<{ status: string }> => {
    await getDb().get('SELECT 1');
    return { status: 'ok' };
  });

  app.post<AuthRequest>('/api/auth/request', async (req: FastifyRequest<AuthRequest>, reply: FastifyReply): Promise<unknown> => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !email.includes('@')) {
      return reply.code(400).send({ error: 'Enter a valid email address' });
    }
    if (await isEmailAllowed(email)) {
      let token: string;
      try {
        token = await createMagicToken(email);
      } catch (error) {
        if (error instanceof MagicLinkRateLimitError) return reply.code(429).send({ error: error.message });
        throw error;
      }
      try {
        await send(email, `${origin}/auth/verify?token=${token}`);
      } catch {
        await getDb().run('DELETE FROM magic_tokens WHERE token=?', [token]);
        return reply.code(503).send({ error: 'Email delivery unavailable. Contact the administrator.' });
      }
    }
    return { message: 'If your email is on the allowlist, a sign-in link is on its way.' };
  });

  app.get<VerifyRequest>('/auth/verify', async (req: FastifyRequest<VerifyRequest>, reply: FastifyReply): Promise<unknown> => {
    const user = typeof req.query.token === 'string' ? await verifyMagicToken(req.query.token) : null;
    if (!user) {
      return reply.code(401).type('text/html')
        .send(page(undefined, 'This sign-in link has expired or was already used. Request another below.'));
    }
    const token = await createSession(user.id);
    reply.setCookie('session', token, {
      path: '/', httpOnly: true, secure: origin.startsWith('https://'), sameSite: 'lax', maxAge: 30 * 86400,
    });
    return reply.redirect('/');
  });

  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    await getDb().run('DELETE FROM sessions WHERE token=?', [req.cookies.session || '']);
    reply.clearCookie('session', { path: '/' });
    return { status: 'ok' };
  });

  app.post('/api/upload', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const user = await userFor(req);
    if (!user) return reply.code(401).send({ error: 'Please sign in again' });
    let inputPath: string | undefined;
    try {
      let buffer: Buffer | undefined;
      let name = 'document.docx';
      const fields: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || !part.filename.toLowerCase().endsWith('.docx')) {
            throw new Error('Choose a DOCX file');
          }
          buffer = await part.toBuffer();
          name = path.basename(part.filename).slice(0, 200);
          if (part.file.truncated) return reply.code(413).send({ error: 'Maximum upload size is 2 MiB' });
        } else {
          if (!['from', 'to'].includes(part.fieldname) || fields[part.fieldname]) {
            throw new Error('Invalid or duplicate language field');
          }
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!buffer) throw new Error('Choose a DOCX file');
      if (![fields.from, fields.to].every((value: string): boolean => Boolean(value && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(value))) || fields.from === fields.to) {
        throw new Error('Choose different source and target languages');
      }
      await validateUpload(buffer);
      const id = randomUUID();
      const filename = `${id}-input.docx`;
      inputPath = path.join(directory, filename);
      await fs.writeFile(inputPath, buffer);
      // Single conditional INSERT makes concurrent admissions atomic on our one SQLite writer.
      const inserted = await getDb().get<{ id: string }>(
        `INSERT INTO jobs (id,user_id,input_filename,from_lang,to_lang,original_name,created_at)
         SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM jobs WHERE user_id=? AND status IN ('queued','running')) < 2
         AND (SELECT count(*) FROM jobs WHERE user_id=? AND julianday(created_at)>julianday('now','-1 day')) < 10
         AND (SELECT count(*) FROM jobs WHERE status IN ('queued','running')) < 50 RETURNING id`,
        [id, user.id, filename, fields.from, fields.to, name, new Date().toISOString(), user.id, user.id],
      );
      if (!inserted) {
        await fs.unlink(inputPath);
        return reply.code(429).send({ error: 'Admission limit reached: 2 active jobs, 10 uploads per user per day, or 50 queued jobs globally. Try later.' });
      }
      return reply.code(202).send({ id, status: 'queued' });
    } catch (error) {
      if (inputPath) await fs.unlink(inputPath).catch((): void => {});
      const code = (error as { code?: string }).code;
      return reply.code(code?.includes('LIMIT') || code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400).send({
        error: code ? 'Upload exceeds the allowed size or number of parts (one DOCX, 2 MiB).'
          : error instanceof Error ? error.message : 'Upload failed',
      });
    }
  });

  const visible = `julianday(created_at)>julianday('now','-1 day')`;
  app.get('/api/jobs', async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const user = await userFor(req);
    if (!user) return reply.code(401).send({ error: 'Please sign in again' });
    return getDb().all<Job>(`SELECT * FROM jobs WHERE user_id=? AND ${visible} ORDER BY created_at DESC LIMIT 50`, [user.id]);
  });
  app.get<JobRequest>('/api/jobs/:id', async (req: FastifyRequest<JobRequest>, reply: FastifyReply): Promise<unknown> => {
    const user = await userFor(req);
    if (!user) return reply.code(401).send({ error: 'Please sign in again' });
    const job = await getDb().get<Job>(`SELECT * FROM jobs WHERE id=? AND user_id=? AND ${visible}`, [req.params.id, user.id]);
    return job || reply.code(404).send({ error: 'Job not found or expired' });
  });
  app.get<JobRequest>('/api/download/:id', async (req: FastifyRequest<JobRequest>, reply: FastifyReply): Promise<unknown> => {
    const user = await userFor(req);
    if (!user) return reply.code(401).send({ error: 'Please sign in again' });
    const job = await getDb().get<Job>(
      `SELECT * FROM jobs WHERE id=? AND user_id=? AND status='done' AND ${visible}`,
      [req.params.id, user.id],
    );
    if (!job?.output_filename) return reply.code(404).send({ error: 'File not found or expired' });
    try {
      await fs.access(path.join(directory, job.output_filename));
    } catch {
      return reply.code(404).send({ error: 'File unavailable' });
    }
    return reply.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', 'attachment; filename="translated.docx"')
      .send(createReadStream(path.join(directory, job.output_filename)));
  });

  const reportCleanupError = (error: unknown): void => app.log.error(error, 'File retention cleanup failed');
  await purgeExpiredOutputs(directory, reportCleanupError);
  await deleteExpiredTokens();
  let maintenance = Promise.resolve();
  const timer = setInterval((): void => {
    maintenance = maintenance.then(async (): Promise<void> => {
      await purgeExpiredOutputs(directory, reportCleanupError);
      await deleteExpiredTokens();
    }).catch((error: unknown): void => app.log.error(error));
  }, 60000);
  if (options.worker !== false) await jobQueue.start();
  app.addHook('onClose', async (): Promise<void> => {
    clearInterval(timer);
    await jobQueue.stop();
    await maintenance;
    smtp.close();
    await closeDb();
  });
  return { app, jobQueue, quotaStore, close: (): Promise<void> => app.close() };
}

async function main(): Promise<void> {
  const { app, close } = await buildServer();
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, (): void => {
      if (closing) return;
      closing = true;
      close().catch((error: unknown): void => { console.error(error); process.exitCode = 1; });
    });
  }
  try {
    await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error);
    await close();
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
