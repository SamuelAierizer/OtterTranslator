/**
 * Google Cloud Translation API free tier backend.
 * 500k chars/month free, official API, no-train confirmed.
 */

import type { TranslationBackend } from '../backend.js';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';

const GOOGLE_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;
const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';

interface CharQuota {
  used: number;
  limit: number;
  resetDay: number;
}

export class GoogleCloudTranslationBackend implements TranslationBackend {
  name = 'google-cloud';
  private rateLimiter: RateLimiter;
  private charQuota: CharQuota;
  private blockedUntil: number = 0;
  private consecutiveErrors: number = 0;

  constructor(private apiKey: string = GOOGLE_API_KEY || '') {
    this.rateLimiter = new RateLimiter({ tokensPerSecond: 50 });
    this.charQuota = this.initializeQuota();
  }

  private initializeQuota(): CharQuota {
    const today = new Date();
    return {
      used: 0,
      limit: 500_000,
      resetDay: today.getDate(),
    };
  }

  private checkMonthlyReset(): void {
    const today = new Date();
    const currentDay = today.getDate();
    if (currentDay !== this.charQuota.resetDay) {
      this.charQuota.resetDay = currentDay;
      this.charQuota.used = 0;
    }
  }

  private getAvailableQuota(): number {
    this.checkMonthlyReset();
    return Math.max(0, this.charQuota.limit - this.charQuota.used);
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
    const availableQuota = this.getAvailableQuota();

    if (totalChars > availableQuota) {
      throw new QuotaExhaustedError(
        `Google Cloud quota exhausted: need ${totalChars}, have ${availableQuota}`
      );
    }

    const results: string[] = [];

    for (const text of texts) {
      if (signal?.aborted) throw new Error('Translation aborted');

      const translated = await this.translateSingle(text, from, to, signal);
      results.push(translated);
      this.charQuota.used += text.length;
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    if (signal?.aborted) throw new Error('Translation aborted');

    try {
      const response = await fetch(GOOGLE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey,
        },
        body: JSON.stringify({
          q: text,
          sourceLanguage: from,
          targetLanguage: to,
        }),
        signal: signal || controller.signal,
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
      return data.data?.translations?.[0]?.translatedText || text;
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
