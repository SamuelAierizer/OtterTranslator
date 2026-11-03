/**
 * Google Cloud Translation API free tier backend.
 * 500k chars/month free, official API, no-train confirmed.
 */

import type { TranslationBackend } from '../backend.js';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';
import { InMemoryQuotaStore, QuotaLedger } from '../quota.js';
import type { QuotaStore } from '../types.js';

const GOOGLE_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

export const GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT = 500_000;

export class GoogleCloudTranslationBackend implements TranslationBackend {
  name = 'google-cloud';
  private rateLimiter: RateLimiter;
  private ledger: QuotaLedger;
  private blockedUntil: number = 0;
  private consecutiveErrors: number = 0;

  constructor(
    private apiKey: string = GOOGLE_API_KEY || '',
    quota: QuotaStore = new InMemoryQuotaStore()
  ) {
    this.rateLimiter = new RateLimiter({ tokensPerSecond: 50 });
    this.ledger = new QuotaLedger(this.name, GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT, quota);
  }

  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (this.blockedUntil > Date.now()) {
      throw new TranslationBlockedError(
        `Google Cloud Translation temporarily blocked until ${new Date(this.blockedUntil).toISOString()}`
      );
    }

    const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
    await this.ledger.assertAvailable(totalChars);

    const results: string[] = [];

    for (const text of texts) {
      if (signal?.aborted) throw new Error('Translation aborted');
      if (!text.trim()) { results.push(text); continue; }

      const translated = await this.translateSingle(text, from, to, signal);
      results.push(translated);

      this.consecutiveErrors = 0;
    }

    return results;
  }

  private async translateSingle(
    text: string,
    from: string,
    to: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GOOGLE_CLOUD_API_KEY not configured');
    }

    await this.rateLimiter.acquire(1);

    if (signal?.aborted) throw new Error('Translation aborted');
    await this.ledger.reserve(text.length);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(GOOGLE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
        },
        // v2 REST names these `source`/`target`/`format`; `format: 'text'` keeps the API from
        // HTML-escaping the bracket tags that carry formatting through the pipeline.
        body: JSON.stringify({
          q: text,
          source: from,
          target: to,
          format: 'text',
        }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });

      if (response.status === 429 || response.status === 403) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          this.blockedUntil = Date.now() + 60_000;
          throw new TranslationBlockedError('Google Cloud: repeated 429/403, blocking for 60s');
        }
        throw new QuotaExhaustedError('Google Cloud: rate limited');
      }

      if (!response.ok) {
        throw new Error(`Google Cloud error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { data?: { translations?: Array<{ translatedText: string }> } };
      const translated = data.data?.translations?.[0]?.translatedText;
      if (typeof translated !== 'string' || !translated) throw new Error('Google Cloud returned no translated text');
      return translated;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new BackendTimeoutError('Google Cloud request timeout');
        }
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
