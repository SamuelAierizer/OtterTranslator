import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/server/index.js';
import { startSmtpSink } from '../scripts/support/smtp-sink.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'otter-e2e-'));
let latest = '';
const mail = await startSmtpSink({
  onMessage: (message: string): void => { latest = message; },
});
Object.assign(process.env, {
  DB_PATH: path.join(temp, 'app.db'),
  OUTPUT_DIR: path.join(temp, 'files'),
  ORIGIN: 'http://127.0.0.1:3011',
  EMAIL_ALLOWLIST: 'demo@example.com',
  TRANSLATION_BACKEND: 'identity',
  ENABLE_LLM_REVIEW: 'false',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(mail.port),
  SMTP_FROM: 'otter@example.com',
  SMTP_REQUIRE_TLS: 'false',
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  NODE_ENV: 'test',
});
const server = await buildServer({ logger: false });
// Test harness only; never registered by production buildServer.
server.app.get('/__test/mail', async (): Promise<{ text: string }> => ({ text: latest }));
await server.app.listen({ host: '127.0.0.1', port: 3011 });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async (): Promise<void> => {
    await server.close();
    await mail.close();
    await rm(temp, { recursive: true, force: true });
  });
}
