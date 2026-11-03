import type { TranslationBackend } from '../backend.js';
import type { QuotaStore } from '../types.js';
import { QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { InMemoryQuotaStore } from '../quota.js';
import { MicrosoftTranslatorBackend, MS_MONTHLY_CHAR_LIMIT } from './ms-translator.js';
import { GoogleCloudTranslationBackend, GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT } from './google-cloud.js';
import { IdentityBackend } from './identity.js';

export { IdentityBackend };

/**
 * Free-tier monthly character budgets, by the provider name used as the quota key.
 * Single source of truth: the backends enforce these and `/healthz` reports against them.
 */
export const PROVIDER_LIMITS: Record<string, number> = {
  'microsoft-translator': MS_MONTHLY_CHAR_LIMIT,
  'google-cloud': GOOGLE_CLOUD_MONTHLY_CHAR_LIMIT,
};

export interface CreateBackendOptions {
  msKey?: string;
  gcKey?: string;
  /** Persistence for character budgets. Defaults to in-memory, which resets on process start. */
  quota?: QuotaStore;
}

class CompositeBackend implements TranslationBackend {
  name = 'composite';
  private primary: TranslationBackend;
  private secondary: TranslationBackend;

  constructor(options: CreateBackendOptions) {
    const quota = options.quota ?? new InMemoryQuotaStore();
    this.primary = new MicrosoftTranslatorBackend(options.msKey, quota);
    this.secondary = new GoogleCloudTranslationBackend(options.gcKey, quota);
  }

  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    try {
      return await this.primary.translateBatch(texts, from, to, signal);
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        try {
          return await this.secondary.translateBatch(texts, from, to, signal);
        } catch (secondaryErr) {
          if (secondaryErr instanceof QuotaExhaustedError) {
            throw new QuotaExhaustedError('All translation backends exhausted');
          }
          throw secondaryErr;
        }
      }
      if (err instanceof TranslationBlockedError) {
        try {
          return await this.secondary.translateBatch(texts, from, to, signal);
        } catch (secondaryErr) {
          if (secondaryErr instanceof TranslationBlockedError) {
            throw new TranslationBlockedError('All translation backends blocked');
          }
          throw secondaryErr;
        }
      }
      throw err;
    }
  }
}

export function createBackend(name?: string, options: CreateBackendOptions = {}): TranslationBackend {
  if (name === 'identity') return new IdentityBackend();

  if (name && !['composite', 'google'].includes(name)) throw new Error(`Unknown translation backend: ${name}`);

  // Every other name resolves to the quota-routed composite: the free Google web endpoint is
  // dead (see backends/google-web.ts) and there is no third provider to select between.
  return new CompositeBackend({
    ...options,
    msKey: options.msKey ?? process.env.MS_TRANSLATOR_KEY,
    gcKey: options.gcKey ?? process.env.GOOGLE_CLOUD_API_KEY,
  });
}
