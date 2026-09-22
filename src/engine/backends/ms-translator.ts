/**
 * Microsoft Translator (Azure F0 tier) backend.
 * 2M chars/month free, 50k chars/request cap.
 * No-Trace policy: no training data retention.
 */

import type { TranslationBackend } from '../backend.js';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';

const MS_REGION = process.env.MS_TRANSLATOR_REGION || 'eastus';
const MS_KEY = process.env.MS_TRANSLATOR_KEY;
const MS_ENDPOINT = `https://${MS_REGION}.api.cognitive.microsofttranslator.com`;

interface CharQuota {
  used: number;
  limit: number;
  resetDay: number; // day of month (1-31)
}

export class MicrosoftTranslatorBackend implements TranslationBackend {
  name = 'microsoft-translator';
  private rateLimiter: RateLimiter;
  private charQuota: CharQuota;
  private blockedUntil: number = 0;
  private consecutiveErrors: number = 0;

  constructor(private apiKey: string = MS_KEY || '') {
    this.rateLimiter = new RateLimiter({ tokensPerSecond: 100 });
    this.charQuota = this.initializeQuota();
  }

  private initializeQuota(): CharQuota {
    const today = new Date();
    return {
      used: 0,
      limit: 2_000_000,
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

  private splitText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let current = '';

    for (const char of text) {
      if ((current + char).length > maxChars) {
        if (current) chunks.push(current);
        current = char;
      } else {
        current += char;
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (this.blockedUntil > Date.now()) {
      throw new TranslationBlockedError(
        `Microsoft Translator temporarily blocked until ${new Date(this.blockedUntil).toISOString()}`
      );
    }

    const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
    const availableQuota = this.getAvailableQuota();

    if (totalChars > availableQuota) {
      throw new QuotaExhaustedError(
        `Microsoft quota exhausted: need ${totalChars}, have ${availableQuota}`
      );
    }

    const results: string[] = [];

    for (const text of texts) {
      if (signal?.aborted) throw new Error('Translation aborted');

      const chunks = this.splitText(text, 50000);
      const translatedChunks: string[] = [];

      for (const chunk of chunks) {
        const translated = await this.translateSingle(chunk, from, to, signal);
        translatedChunks.push(translated);
      }

      // Preserve leading/trailing whitespace
      const leadingSpace = text.match(/^\s*/)?.[0] || '';
      const trailingSpace = text.match(/\s*$/)?.[0] || '';
      const combined = translatedChunks.join('');
      results.push(leadingSpace + combined.trim() + trailingSpace);

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
      throw new Error('MS_TRANSLATOR_KEY not configured');
    }

    await this.rateLimiter.acquire(1);

    const url = new URL(`${MS_ENDPOINT}/translate`);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    if (signal?.aborted) throw new Error('Translation aborted');

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.apiKey,
          'Ocp-Apim-Subscription-Region': MS_REGION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ text }]),
        signal: signal || controller.signal,
      });

      if (response.status === 429 || response.status === 403) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          this.blockedUntil = Date.now() + 60_000;
          throw new TranslationBlockedError('Microsoft Translator: repeated 429/403, blocking for 60s');
        }
        throw new QuotaExhaustedError('Microsoft Translator: rate limited');
      }

      if (!response.ok) {
        throw new Error(`Microsoft Translator error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as Array<{ translations: Array<{ text: string }> }>;
      return data[0]?.translations[0]?.text || text;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new BackendTimeoutError('Microsoft Translator request timeout');
        }
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
