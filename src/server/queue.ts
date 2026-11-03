import { promises as fs } from 'fs';
import path from 'path';
import { getDb } from './db.js';
import { translateDocx } from '../engine/index.js';
import { QuotaExhaustedError, TranslationBlockedError } from '../engine/errors.js';
import type { Job, QuotaStore } from './types.js';

/** Serial translation worker. The owning server must await stop before closing SQLite. */
export class JobQueue {
  private running = false;
  private loop?: Promise<void>;
  private controller?: AbortController;
  private wake?: () => void;

  constructor(
    private quotaStore: QuotaStore,
    private directory: string = process.env.OUTPUT_DIR || '/data/outputs',
    private translate: typeof translateDocx = translateDocx,
  ) {}

  /** Recover interrupted work without retrying provider calls, then start the worker. */
  async start(): Promise<void> {
    if (this.running) return;
    await getDb().run(
      `UPDATE jobs SET status='failed', stage='interrupted',
       error_message='Server restarted during translation. Please submit again.',
       completed_at=? WHERE status='running'`,
      [new Date().toISOString()],
    );
    this.running = true;
    this.loop = this.processQueue();
  }

  /** Stop taking jobs, abort active provider work and await all worker writes. */
  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    this.wake?.();
    await this.loop;
  }

  private async processQueue(): Promise<void> {
    while (this.running) {
      try {
        const job = await getDb().get<Job>(
          `SELECT * FROM jobs WHERE status='queued'
           AND julianday(created_at)>julianday('now','-1 day')
           ORDER BY created_at, rowid LIMIT 1`,
        );
        if (job && this.running) {
          await this.processJob(job);
        } else {
          await new Promise<void>((resolve: () => void): void => {
            const timer = setTimeout(resolve, 250);
            this.wake = (): void => { clearTimeout(timer); resolve(); };
          });
        }
      } catch (error) {
        console.error('Queue processing error', error);
        await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 1000); });
      }
    }
  }

  private async processJob(job: Job): Promise<void> {
    const db = getDb();
    let updates = Promise.resolve();
    let progressError: Error | undefined;
    let retained = 0;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout((): void => controller.abort(), 30 * 60 * 1000);

    try {
      // Recheck expiry atomically when claiming, including time spent after selection.
      const claimed = await db.get<{ id: string }>(
        `UPDATE jobs SET status='running', stage='validating'
         WHERE id=? AND status='queued'
         AND julianday(created_at)>julianday('now','-1 day') RETURNING id`,
        [job.id],
      );
      if (!claimed) return;

      const buffer = await fs.readFile(path.join(this.directory, job.input_filename));
      const output = await this.translate(buffer, {
        signal: controller.signal,
        from: job.from_lang,
        to: job.to_lang,
        quota: this.quotaStore,
        verify: process.env.ENABLE_LLM_REVIEW === 'true',
        onStage: (stage: string, progress: number): void => {
          updates = updates.then(async (): Promise<void> => {
            if (progressError) return;
            try {
              await db.run('UPDATE jobs SET stage=?, progress=? WHERE id=?', [stage, progress, job.id]);
            } catch (error) {
              // Handle immediately: provider work may remain in flight for seconds.
              // Keep this chain fulfilled and fail the job after its writes drain.
              progressError = error instanceof Error ? error : new Error('Failed to save job progress');
              controller.abort();
            }
          });
        },
        onTagMismatch: (): void => { retained++; },
      });
      await updates;
      if (progressError) throw progressError;
      if (controller.signal.aborted) throw new Error('Translation interrupted or timed out. Submit again to retry.');

      const filename = `${job.id}.docx`;
      await fs.writeFile(path.join(this.directory, filename + '.tmp'), output);
      await fs.rename(path.join(this.directory, filename + '.tmp'), path.join(this.directory, filename));
      await db.run(
        `UPDATE jobs SET status='done', stage='done', progress=100,
         retained_blocks=?, output_filename=?, completed_at=? WHERE id=?`,
        [retained, filename, new Date().toISOString(), job.id],
      );
    } catch (error) {
      await updates;
      const failure = progressError || error;
      const status = failure instanceof QuotaExhaustedError ? 'quota_exhausted'
        : failure instanceof TranslationBlockedError ? 'blocked' : 'failed';
      const message = progressError ? progressError.message
        : controller.signal.aborted ? 'Translation interrupted or timed out. Submit again to retry.'
          : failure instanceof Error ? failure.message : 'Translation failed';
      await db.run(
        'UPDATE jobs SET status=?, stage=?, error_message=?, completed_at=? WHERE id=?',
        [status, status, message, new Date().toISOString(), job.id],
      );
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
    }
  }
}
