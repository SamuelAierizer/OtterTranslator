/**
 * Core type definitions for the DOCX Translation Pipeline
 */

import type { ChatProvider as VerifyProvider } from './verify/provider.js';

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

export interface TranslateOptions {
  from: string;
  to: string;
  /** Backend name passed to `createBackend`; defaults to the quota-routed composite. */
  backend?: string;
  /** Set false to skip the stage-2 LLM review pass. It is otherwise on, and fails open. */
  verify?: boolean;
  /** Review providers; defaults to Cerebras then Groq, built from the environment. */
  verifyProviders?: VerifyProvider[];
  onProgress?: (done: number, total: number, part: string) => void;
  signal?: AbortSignal;
}
