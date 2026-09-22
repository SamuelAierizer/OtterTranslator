/**
 * Google Translate web endpoint (free, undocumented).
 *
 * DEPRECATED: This endpoint is currently returning 429 (rate limit) from all tested networks
 * as of Sept 2026. See docs/spike-backend.md § for evidence. Kept here as documentation
 * of what was tried and for reference if the endpoint ever recovers.
 *
 * DO NOT wire this into createBackend() — the Microsoft + Google Cloud official APIs
 * are the canonical implementation. This file exists only as a historical record.
 */

import type { TranslationBackend } from '../backend.js';

export class GoogleWebTranslatorBackend implements TranslationBackend {
  name = 'google-web';

  async translateBatch(): Promise<string[]> {
    throw new Error(
      'Google web endpoint is currently blocked (HTTP 429 from all tested networks). ' +
        'See docs/spike-backend.md for details. Use microsoft-translator or google-cloud instead.'
    );
  }
}
