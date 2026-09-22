import { promises as fs } from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { translateDocx } from '../engine/index.js';
import {
  TranslationBlockedError,
  DocumentTooLargeError,
  MalformedDocxError,
  QuotaExhaustedError,
} from '../engine/errors.js';
import type { Job } from './types.js';
import type { QuotaStore } from './types.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/outputs';
const PROVIDERS = ['google', 'ollama'];
const MONTHLY_LIMITS: Record<string, number> = {
  google: 500000,
  ollama: 0,
};

export class JobQueue {
  private quotaStore: QuotaStore;
  private running = false;

  constructor(quotaStore: QuotaStore) {
    this.quotaStore = quotaStore;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.processQueue();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async processQueue(): Promise<void> {
    while (this.running) {
      try {
        const db = getDb();
        const job = await db.get<Job>(
          `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`
        );

        if (!job) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        await this.processJob(job);
      } catch (err) {
        console.error('Queue processing error:', err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async processJob(job: Job): Promise<void> {
    const db = getDb();

    try {
      await db.run(`UPDATE jobs SET status = 'running' WHERE id = ?`, [job.id]);

      // Read input file
      const inputPath = path.join(OUTPUT_DIR, job.input_filename);
      const buffer = await fs.readFile(inputPath);

      // Check quota
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const provider = process.env.TRANSLATION_BACKEND || 'google';
      const limit = MONTHLY_LIMITS[provider] || 500000;

      const canProceed = await this.quotaStore.checkAndIncrement(
        provider,
        month,
        buffer.length,
        limit,
        job.user_id
      );

      if (!canProceed) {
        await db.run(
          `UPDATE jobs SET status = 'quota_exhausted', completed_at = datetime('now') WHERE id = ?`,
          [job.id]
        );
        return;
      }

      // Translate
      const outputBuffer = await translateDocx(buffer, {
        from: job.from_lang,
        to: job.to_lang,
      });

      // Write output
      const outputFilename = `${job.id}.docx`;
      const outputPath = path.join(OUTPUT_DIR, outputFilename);
      await fs.writeFile(outputPath, outputBuffer);

      // Update job
      await db.run(
        `UPDATE jobs SET status = 'done', output_filename = ?, completed_at = datetime('now') WHERE id = ?`,
        [outputFilename, job.id]
      );
    } catch (err: unknown) {
      const db = getDb();
      let status = 'failed';
      let message = 'Unknown error';

      if (err instanceof Error) {
        message = err.message;
        const name = (err as any).code || err.name;
        if (name === 'TRANSLATION_BLOCKED') {
          status = 'blocked';
        } else if (name === 'QUOTA_EXHAUSTED') {
          status = 'quota_exhausted';
        } else if (name === 'DOCUMENT_TOO_LARGE') {
          message = 'Document is too large';
        } else if (name === 'MALFORMED_DOCX') {
          message = 'Document is malformed';
        }
      }

      await db.run(
        `UPDATE jobs SET status = ?, error_message = ?, completed_at = datetime('now') WHERE id = ?`,
        [status, message, job.id]
      );
    }
  }
}
