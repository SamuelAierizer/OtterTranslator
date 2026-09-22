/**
 * Identity backend for testing — returns input text unchanged.
 * Useful for testing orchestration logic without hitting actual translation services.
 */

import type { TranslationBackend } from '../backend.js';

export class IdentityBackend implements TranslationBackend {
  name = 'identity';

  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (signal?.aborted) throw new Error('Translation aborted');
    return texts;
  }
}
