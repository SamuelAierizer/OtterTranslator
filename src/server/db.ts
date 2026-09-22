import sqlite3 from 'sqlite3';
import path from 'path';
import { promisify } from 'util';

// Resolved per `initDb()` call rather than at module load: the module is imported long before
// the process environment is final (tests point DB_PATH at a temp file after importing), and a
// path captured at load time silently falls back to the production /data path.
function resolveDbPath(): string {
  return process.env.DB_PATH || '/data/app.db';
}

export interface Database {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

let db: sqlite3.Database;
let dbReady: Promise<void>;

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return wrapDb(db);
}

export async function initDb(): Promise<Database> {
  if (db) return wrapDb(db);

  dbReady = new Promise((resolve, reject) => {
    db = new sqlite3.Database(resolveDbPath(), (err) => {
      if (err) reject(err);
      else {
        db.configure('busyTimeout', 5000);
        setupSchema()
          .then(() => resolve())
          .catch(reject);
      }
    });
  });

  await dbReady;
  return wrapDb(db);
}

export async function closeDb(): Promise<void> {
  if (!db) return;
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else {
        db = null as any;
        dbReady = null as any;
        resolve();
      }
    });
  });
}

function wrapDb(database: sqlite3.Database): Database {
  return {
    run: (sql: string, params: any[] = []): Promise<void> =>
      new Promise((resolve, reject) => {
        database.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve();
        });
      }),
    get: <T,>(sql: string, params: any[] = []): Promise<T | undefined> =>
      new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row as T | undefined);
        });
      }),
    all: <T,>(sql: string, params: any[] = []): Promise<T[]> =>
      new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows as T[]);
        });
      }),
    exec: (sql: string): Promise<void> =>
      new Promise((resolve, reject) => {
        database.exec(sql, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    close: (): Promise<void> =>
      new Promise((resolve, reject) => {
        database.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

async function setupSchema(): Promise<void> {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS magic_tokens (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      used BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      input_filename TEXT NOT NULL,
      output_filename TEXT,
      from_lang TEXT NOT NULL,
      to_lang TEXT NOT NULL,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quota_usage (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      user_id TEXT,
      month TEXT NOT NULL,
      characters_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, user_id, month),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_magic_tokens_email ON magic_tokens(email);
    CREATE INDEX IF NOT EXISTS idx_magic_tokens_expires_at ON magic_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
    CREATE INDEX IF NOT EXISTS idx_quota_usage_provider_month ON quota_usage(provider, month);
  `;

  return new Promise((resolve, reject) => {
    db.exec(schema, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
