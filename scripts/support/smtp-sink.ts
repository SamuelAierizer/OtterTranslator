import net from 'node:net';

/** A listening local mailbox and the operation that releases it. */
export interface SmtpSink {
  port: number;
  close: () => Promise<void>;
}

/** Optional port selection and the decoded-message consumer. */
export interface SmtpSinkOptions {
  port?: number;
  onMessage: (message: string) => void;
}

function decodeMessage(lines: string[]): string {
  return lines.join('\n')
    .replace(/=\n/g, '')
    .replace(/=([A-F0-9]{2})/g, (_match: string, hex: string): string => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Start a loopback-only SMTP receiver for local demos and browser tests.
 * Messages are passed to the callback, never delivered externally. Port zero
 * selects an available port. The caller must await close() to release sockets.
 */
export async function startSmtpSink(options: SmtpSinkOptions): Promise<SmtpSink> {
  const connections = new Set<net.Socket>();
  const server = net.createServer((socket: net.Socket): void => {
    connections.add(socket);
    socket.on('close', (): void => { connections.delete(socket); });
    socket.on('error', (): void => {});
    socket.setEncoding('utf8');
    socket.write('220 localhost Otter development mailbox\r\n');
    let pending = '';
    let receivingData = false;
    let lines: string[] = [];

    socket.on('data', (chunk: string): void => {
      pending += chunk;
      while (pending.includes('\r\n')) {
        const end = pending.indexOf('\r\n');
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (receivingData) {
          if (line === '.') {
            receivingData = false;
            options.onMessage(decodeMessage(lines));
            lines = [];
            socket.write('250 accepted\r\n');
          } else {
            lines.push(line.startsWith('..') ? line.slice(1) : line);
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write('250 localhost\r\n');
        } else if (/^DATA/i.test(line)) {
          receivingData = true;
          socket.write('354 send data\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.end('221 goodbye\r\n');
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', (): void => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    close: (): Promise<void> => new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      server.close((error?: Error): void => { if (error) reject(error); else resolve(); });
      for (const socket of connections) socket.destroy();
    }),
  };
}
