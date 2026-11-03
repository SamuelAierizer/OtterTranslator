import { promises as fs } from 'fs';
import path from 'path';
import { getDb } from './db.js';
import type { Job } from './types.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;

async function deleteFile(filename: string): Promise<void> {
  try {
    await fs.unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Remove expired job artifacts and old orphan files from the managed directory.
 * A filesystem failure is reported and its job row is kept for a later retry;
 * other jobs continue to be cleaned. Database errors still reject the operation.
 * Returns the number of job rows successfully removed, excluding orphan files.
 */
export async function purgeExpiredOutputs(
  directory: string = process.env.OUTPUT_DIR || '/data/outputs',
  reportError: (error: unknown) => void = console.error,
): Promise<number> {
  const db = getDb();
  const expiredJobs = await db.all<Job>(
    `SELECT * FROM jobs WHERE status!='running'
     AND julianday(created_at)<=julianday('now','-1 day')`,
  );
  let removedJobs = 0;

  for (const job of expiredJobs) {
    try {
      for (const filename of [job.input_filename, job.output_filename]) {
        if (filename) await deleteFile(path.join(directory, filename));
      }
    } catch (error) {
      reportError(error);
      continue;
    }
    await db.run('DELETE FROM jobs WHERE id=?', [job.id]);
    removedJobs++;
  }

  const liveJobs = await db.all<Job>('SELECT * FROM jobs');
  const referencedFiles = new Set(liveJobs.flatMap((job: Job): (string | null)[] => [job.input_filename, job.output_filename]));
  for (const file of await fs.readdir(directory)) {
    if (referencedFiles.has(file) || !/^[a-f0-9-]{36}(?:-input)?\.docx(?:\.tmp)?$/.test(file)) continue;
    try {
      const filename = path.join(directory, file);
      if ((await fs.stat(filename)).mtimeMs <= Date.now() - RETENTION_MS) await deleteFile(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportError(error);
    }
  }
  return removedJobs;
}
