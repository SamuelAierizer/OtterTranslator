export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token: string;
  created_at: string;
  expires_at: string;
}

export interface MagicToken {
  id: string;
  email: string;
  token: string;
  used: boolean;
  created_at: string;
  expires_at: string;
}

export interface Job {
  id: string;
  user_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'quota_exhausted';
  stage: string;
  progress: number;
  retained_blocks: number;
  original_name: string;
  input_filename: string;
  output_filename: string | null;
  from_lang: string;
  to_lang: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface QuotaUsage {
  id: string;
  provider: string;
  month: string;
  characters_used: number;
  created_at: string;
}

// The quota contract belongs to the engine — it is the engine that spends the budget, and the
// server only supplies the storage. Re-exported here so server code has one place to import from.
export type { QuotaStore } from '../engine/types.js';
