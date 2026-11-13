import type { TranslationBackend } from '../backend.js';
import { RateLimiter } from '../rate-limit.js';
import { InMemoryQuotaStore, QuotaLedger } from '../quota.js';
import type { QuotaStore } from '../types.js';
import { translatePacked } from './batching.js';
import { providerRequest } from './request.js';
import { normalizeTranslation } from '../tags.js';
export const GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT = 500_000;
export class GoogleCloudTranslationBackend implements TranslationBackend {
  name = 'google-cloud';
  private rateLimiter = new RateLimiter({ tokensPerSecond: 50 });
  private ledger: QuotaLedger;
  constructor(private apiKey = process.env.GOOGLE_CLOUD_API_KEY || '', quota: QuotaStore = new InMemoryQuotaStore()) {
    this.ledger = new QuotaLedger(this.name, GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT, quota);
  }
  async translateBatch(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]> {
    await this.ledger.assertAvailable(texts.reduce((sum, t) => sum + t.length, 0));
    // 10K UTF-16 units keeps even JSON-escaped input comfortably below Basic's 100K byte cap.
    return translatePacked(texts, 10_000, 128, async batch => {
      if (!this.apiKey) throw new Error('GOOGLE_CLOUD_API_KEY not configured');
      const chars = batch.reduce((sum, text) => sum + text.length, 0);
      const data = await providerRequest(requestSignal => fetch('https://translation.googleapis.com/language/translate/v2', {
        method:'POST', headers:{ 'Content-Type':'application/json', 'X-Goog-Api-Key':this.apiKey },
        body:JSON.stringify({ q:batch, source:from, target:to, format:'text' }), signal:requestSignal
      }), async () => { await this.rateLimiter.acquire(); signal?.throwIfAborted(); await this.ledger.reserve(chars); }, signal);
      const items = data?.data?.translations;
      return Array.isArray(items) ? items.map((item: any, i: number) => typeof item?.translatedText === 'string' ? normalizeTranslation(batch[i] ?? '', item.translatedText) : undefined) : [];
    }, signal);
  }
}
