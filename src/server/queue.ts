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

      // Quota is metered by the backends in translatable characters, against each provider's own
      // monthly limit — the queue must not pre-charge, it has only the zipped byte count and no
      // idea which provider will serve the job. Exhaustion arrives as QuotaExhaustedError below.
      const outputBuffer = await translateDocx(buffer, {
        from: job.from_lang,
        to: job.to_lang,
        quota: this.quotaStore,
        onTagMismatch: (blockId, partName) => {
          console.warn(`job ${job.id}: kept source text for ${partName} block ${blockId}`);
        },
      });

      // Write output
      const outputFilename = `${job.id}.docx`;
      const outputPath = path.join(OUTPUT_DIR, outputFilename);
      await fs.writeFile(outputPath, outputBuffer);

      // Update job
      await db.run(
        `UPDATE jobs SET status = 'done', output_filename = ?, completed_at = ? WHERE id = ?`,
        [outputFilename, new Date().toISOString(), job.id]
      );
    } catch (err: unknown) {
      const db = getDb();
      let status = 'failed';
      let message = 'Unknown error';

      if (err instanceof QuotaExhaustedError) {
        status = 'quota_exhausted';
        message = 'Out of free monthly translation budget. Retry after the quota resets.';
      } else if (err instanceof TranslationBlockedError) {
        status = 'blocked';
        message = 'The translation provider refused the request.';
      } else if (err instanceof DocumentTooLargeError) {
        message = 'Document is too large.';
      } else if (err instanceof MalformedDocxError) {
        message = 'Document is not a readable DOCX file.';
      } else if (err instanceof Error) {
        message = err.message;
      }

      await db.run(
        `UPDATE jobs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?`,
        [status, message, new Date().toISOString(), job.id]
      );
    }
  }
}
