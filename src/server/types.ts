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
  user_id: string | null;
  month: string;
  characters_used: number;
  created_at: string;
}

export interface QuotaStore {
  checkAndIncrement(
    provider: string,
    month: string,
    characters: number,
    limit: number,
    userId?: string
  ): Promise<boolean>;
  getUsage(provider: string, month: string, userId?: string): Promise<number>;
  reset(provider: string, month: string): Promise<void>;
}
