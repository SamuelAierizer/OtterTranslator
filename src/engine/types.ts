/**
 * Core type definitions for the DOCX Translation Pipeline
 */

import type { ChatProvider as VerifyProvider } from './verify/provider.js';
import type { TranslationBackend } from './backend.js';

export type { VerifyProvider };

export interface TranslationBlock {
  id: string;
  text: string;
  partName: string;
  wpNode: any; // w:p paragraph node from XML DOM
  styleMap: Map<string, any>; // styleId -> w:rPr (run properties)
}

export interface CLIOptions {
  input: string;
  output: string;
  from?: string;
  to?: string;
  engine?: 'google' | 'ollama';
  model?: string;
  batchSize?: number;
}

/**
 * Persistence for free-tier character budgets, injected by the caller.
 *
 * The engine deliberately does not know how this is stored: the CLI gets an in-memory
 * implementation, the server backs it with SQLite on the persistent volume. Usage is bucketed by
 * calendar-month key (see `currentMonth`), which is what makes the monthly reset automatic.
 */
export interface QuotaStore {
  getUsage(provider: string, month: string): Promise<number>;
  addUsage(provider: string, month: string, characters: number): Promise<void>;
}

export interface TranslateOptions {
  from: string;
  to: string;
  /** Backend name passed to `createBackend`; defaults to the quota-routed composite. */
  backend?: string;
  /** A ready-made backend, used in place of `backend`. Lets tests drive the pipeline offline. */
  backendImpl?: TranslationBackend;
  /** Set false to skip the stage-2 LLM review pass. It is otherwise on, and fails open. */
  verify?: boolean;
  /** Review providers; defaults to Cerebras then Groq, built from the environment. */
  verifyProviders?: VerifyProvider[];
  /**
   * Where free-tier character usage is recorded. Defaults to an in-memory store, which resets on
   * process start — a long-running service must inject a persistent one.
   */
  quota?: QuotaStore;
  /**
   * Called for each paragraph whose translation failed tag validation. Those paragraphs keep their
   * source text; without this callback the substitution is invisible.
   */
  onTagMismatch?: (blockId: string, partName: string) => void;
  onProgress?: (done: number, total: number, part: string) => void;
  signal?: AbortSignal;
}
