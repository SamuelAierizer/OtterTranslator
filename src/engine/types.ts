/**
 * Core type definitions for the DOCX Translation Pipeline
 */

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
  onProgress?: (done: number, total: number, part: string) => void;
  signal?: AbortSignal;
}
