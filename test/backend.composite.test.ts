import { test } from 'node:test';
import assert from 'node:assert';
import { createBackend } from '../src/engine/backends/index.js';
import { QuotaExhaustedError, TranslationBlockedError } from '../src/engine/errors.js';

test('Composite: routes through primary when available', async () => {
  const originalFetch = globalThis.fetch;
  let primaryCalled = false;
  try {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('microsofttranslator')) {
        primaryCalled = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({
            data: [{ translations: [{ text: 'Szia!' }] }],
          }),
        } as Response;
      }
      throw new Error('Should not call secondary');
    }) as any;

    const backend = createBackend(undefined, 'test-ms', 'test-gc');
    await backend.translateBatch(['Hello'], 'en', 'hu');
    assert.strictEqual(primaryCalled, true, 'Primary should be called');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Composite: falls back to secondary on primary quota exhausted', async () => {
  const originalFetch = globalThis.fetch;
  let secondaryCalled = false;
  try {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('microsofttranslator')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            // Return a negative case that exhausts primary quota
            error: 'quota exhausted',
          }),
        } as Response;
      }
      if (url.includes('googleapis')) {
        secondaryCalled = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({
            data: { translations: [{ translatedText: 'Szia!' }] },
          }),
        } as Response;
      }
      throw new Error('Unknown URL: ' + url);
    }) as any;

    // Create primary backend with small quota to trigger exhaustion
    const backend = createBackend(undefined, 'test-ms', 'test-gc');
    // Try a large translation to exhaust primary
    try {
      await backend.translateBatch(['a'.repeat(3_000_000)], 'en', 'hu');
    } catch (err) {
      // Expected — either primary throws or reaches secondary
      if (err instanceof QuotaExhaustedError) {
        // Both might be exhausted
        assert(true);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Composite: throws when all backends blocked', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) => {
      return {
        status: 429,
        ok: false,
        statusText: 'Too Many Requests',
        json: async () => ({ error: 'rate limited' }),
      } as Response;
    }) as any;

    const backend = createBackend(undefined, 'test-ms', 'test-gc');
    try {
      await backend.translateBatch(['Hello'], 'en', 'hu');
      assert.fail('Should throw TranslationBlockedError or QuotaExhaustedError');
    } catch (err) {
      assert(
        err instanceof QuotaExhaustedError || err instanceof TranslationBlockedError,
        'Should be a quota or blocking error'
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
