import { test } from 'node:test';
import assert from 'node:assert';
import { MicrosoftTranslatorBackend } from '../src/engine/backends/ms-translator.js';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../src/engine/errors.js';

// Mock fetch for testing
const createMockFetch = (responses: Record<string, Response | Error>) => {
  return async (url: string, init: RequestInit) => {
    const key = `${init.method || 'GET'} ${url}`;
    const response = responses[url.split('?')[0]];
    if (!response) throw new Error(`No mock response for ${key}`);
    if (response instanceof Error) throw response;
    return response;
  };
};

const mockResponse = (status: number, body: unknown) => {
  return {
    status,
    ok: status < 400,
    statusText: `Status ${status}`,
    json: async () => body,
  } as Response;
};

test('Microsoft Translator: successful translation', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      return mockResponse(200, {
        data: [{ translations: [{ text: 'Szia!' }] }],
      });
    }) as any;

    const backend = new MicrosoftTranslatorBackend('test-key');
    const result = await backend.translateBatch(['Hello'], 'en', 'hu');
    assert.deepStrictEqual(result, ['Hello']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Microsoft Translator: 429 rate limit blocks after 3 errors', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  try {
    globalThis.fetch = (() => {
      callCount++;
      return mockResponse(429, { error: 'Too Many Requests' });
    }) as any;

    const backend = new MicrosoftTranslatorBackend('test-key');
    try {
      await backend.translateBatch(['Hello', 'World', 'Test'], 'en', 'hu');
      assert.fail('Should throw QuotaExhaustedError or TranslationBlockedError');
    } catch (err) {
      assert(err instanceof QuotaExhaustedError || err instanceof TranslationBlockedError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Microsoft Translator: timeout throws BackendTimeoutError', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      throw new DOMException('Aborted', 'AbortError');
    }) as any;

    const backend = new MicrosoftTranslatorBackend('test-key');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    try {
      await backend.translateBatch(['Hello'], 'en', 'hu', controller.signal);
      assert.fail('Should throw BackendTimeoutError');
    } catch (err) {
      assert(err instanceof BackendTimeoutError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Microsoft Translator: quota tracking', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      return mockResponse(200, {
        data: [{ translations: [{ text: 'Szia!' }] }],
      });
    }) as any;

    const backend = new MicrosoftTranslatorBackend('test-key');

    // Translate 100 chars
    await backend.translateBatch(['a'.repeat(100)], 'en', 'hu');

    // Should allow 1,999,900 more chars
    try {
      await backend.translateBatch(['a'.repeat(2_000_000)], 'en', 'hu');
      assert.fail('Should throw QuotaExhaustedError');
    } catch (err) {
      assert(err instanceof QuotaExhaustedError);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Microsoft Translator: preserves whitespace', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      return mockResponse(200, {
        data: [{ translations: [{ text: 'Szia' }] }],
      });
    }) as any;

    const backend = new MicrosoftTranslatorBackend('test-key');
    const result = await backend.translateBatch(['  Hello  '], 'en', 'hu');
    assert.strictEqual(result[0].startsWith('  '), true);
    assert.strictEqual(result[0].endsWith('  '), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
