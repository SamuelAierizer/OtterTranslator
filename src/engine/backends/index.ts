import type { TranslationBackend } from '../backend.js';
import { QuotaExhaustedError, TranslationBlockedError } from '../errors.js';
import { MicrosoftTranslatorBackend } from './ms-translator.js';
import { GoogleCloudTranslationBackend } from './google-cloud.js';
import { IdentityBackend } from './identity.js';

export { IdentityBackend };

class CompositeBackend implements TranslationBackend {
  name = 'composite';
  private primary: TranslationBackend;
  private secondary: TranslationBackend;

  constructor(msKey?: string, gcKey?: string) {
    this.primary = new MicrosoftTranslatorBackend(msKey);
    this.secondary = new GoogleCloudTranslationBackend(gcKey);
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

export function createBackend(name?: string, msKey?: string, gcKey?: string): TranslationBackend {
  if (name === 'identity') return new IdentityBackend();

  // Every other name resolves to the quota-routed composite: the free Google web endpoint is
  // dead (see backends/google-web.ts) and there is no third provider to select between.
  return new CompositeBackend(
    msKey || process.env.MS_TRANSLATOR_KEY,
    gcKey || process.env.GOOGLE_CLOUD_API_KEY
  );
}
