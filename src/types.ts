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
