/**
 * Microsoft Translator (Azure F0 tier) backend.
 * 2M chars/month free, 50k chars/request cap.
 * No-Trace policy: no training data retention.
 */

import type { TranslationBackend } from '../backend.js';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';
import { InMemoryQuotaStore, QuotaLedger } from '../quota.js';
import type { QuotaStore } from '../types.js';

const MS_REGION = process.env.MS_TRANSLATOR_REGION || 'eastus';
const MS_KEY = process.env.MS_TRANSLATOR_KEY;
const MS_ENDPOINT = `https://${MS_REGION}.api.cognitive.microsofttranslator.com`;

export const MS_MONTHLY_CHAR_LIMIT = 2_000_000;

export class MicrosoftTranslatorBackend implements TranslationBackend {
  name = 'microsoft-translator';
  private rateLimiter: RateLimiter;
  private ledger: QuotaLedger;
  private blockedUntil: number = 0;
  private consecutiveErrors: number = 0;

  constructor(
    private apiKey: string = MS_KEY || '',
    quota: QuotaStore = new InMemoryQuotaStore()
  ) {
    this.rateLimiter = new RateLimiter({ tokensPerSecond: 100 });
    this.ledger = new QuotaLedger(this.name, MS_MONTHLY_CHAR_LIMIT, quota);
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
    await this.ledger.assertAvailable(totalChars);

    const results: string[] = [];

    for (const text of texts) {
      if (signal?.aborted) throw new Error('Translation aborted');

      const chunks = this.splitText(text, 50000);
      const translatedChunks: string[] = [];

      for (const chunk of chunks) {
        const translated = await this.translateSingle(chunk, from, to, signal);
        translatedChunks.push(translated);
        // Charged per accepted chunk: a request that throws below must not count against the tier.
        await this.ledger.charge(chunk.length);
      }

      // Preserve leading/trailing whitespace
      const leadingSpace = text.match(/^\s*/)?.[0] || '';
      const trailingSpace = text.match(/\s*$/)?.[0] || '';
      const combined = translatedChunks.join('');
      results.push(leadingSpace + combined.trim() + trailingSpace);

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
