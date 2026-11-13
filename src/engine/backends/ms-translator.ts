import type { TranslationBackend } from '../backend.js';
import { CharacterRateLimiter } from '../rate-limit.js';
import { InMemoryQuotaStore, QuotaLedger } from '../quota.js';
import type { QuotaStore } from '../types.js';
import { translatePacked } from './batching.js';
import { providerRequest } from './request.js';
import { normalizeTranslation } from '../tags.js';

export const MS_MONTHLY_CHAR_LIMIT = 2_000_000;
// F0: evenly consume 2M/hour; keep every rolling minute below ~33,300 characters.
const sharedLimiter = new CharacterRateLimiter();
export class MicrosoftTranslatorBackend implements TranslationBackend {
  name = 'microsoft-translator';
  private ledger: QuotaLedger;
  constructor(private apiKey = process.env.MS_TRANSLATOR_KEY || '', quota: QuotaStore = new InMemoryQuotaStore(), private limiter = sharedLimiter) {
    this.ledger = new QuotaLedger(this.name, MS_MONTHLY_CHAR_LIMIT, quota);
  }
  async translateBatch(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]> {
    await this.ledger.assertAvailable(texts.reduce((sum, t) => sum + t.length, 0));
    return translatePacked(texts, 30_000, 1000, async batch => {
      if (!this.apiKey) throw new Error('MS_TRANSLATOR_KEY not configured');
      const url = new URL('https://api.cognitive.microsofttranslator.com/translate');
      url.searchParams.set('api-version', '3.0'); url.searchParams.set('from', from); url.searchParams.set('to', to);
      const chars = batch.reduce((sum, text) => sum + text.length, 0);
      const data = await providerRequest(requestSignal => fetch(url.toString(), {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': this.apiKey, 'Ocp-Apim-Subscription-Region': process.env.MS_TRANSLATOR_REGION || 'eastus', 'Content-Type':'application/json' },
        body: JSON.stringify(batch.map(text => ({ text }))), signal: requestSignal
      }), async () => { await this.limiter.acquire(chars, signal); signal?.throwIfAborted(); await this.ledger.reserve(chars); }, signal);
      return Array.isArray(data) ? data.map((item: any, i: number) => typeof item?.translations?.[0]?.text === 'string' ? normalizeTranslation(batch[i] ?? '', item.translations[0].text) : undefined) : [];
    }, signal);
  }
}
