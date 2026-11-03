import { startSmtpSink } from './support/smtp-sink.js';

const mailbox = await startSmtpSink({
  port: 2525,
  onMessage: (message: string): void => {
    console.log(`\n--- Local message (not delivered) ---\n${message}`);
  },
});
console.log(`Local SMTP mailbox at 127.0.0.1:${mailbox.port}. Messages print here.`);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, (): void => {
    if (closing) return;
    closing = true;
    mailbox.close().catch((error: unknown): void => { console.error(error); process.exitCode = 1; });
  });
}
