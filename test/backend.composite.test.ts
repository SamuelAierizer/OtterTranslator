import { test } from 'node:test';
import assert from 'node:assert';
import { createBackend, IdentityBackend } from '../src/engine/backends/index.ts';
import { InMemoryQuotaStore } from '../src/engine/quota.ts';
import { QuotaExhaustedError, TranslationBlockedError } from '../src/engine/errors.ts';

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('composite: the primary serves the request when it succeeds', async () => {
  const calls: string[] = [];
  const backend = createBackend(undefined, {
    msKey: 'ms',
    gcKey: 'gc',
    quota: new InMemoryQuotaStore(),
  });

  const result = await withFetch(
    (async (url: string | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify([{ translations: [{ text: 'Szia!' }] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
    () => backend.translateBatch(['Hello'], 'en', 'hu')
  );

  assert.deepStrictEqual(result, ['Szia!']);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('microsofttranslator'));
});

test('composite: sustained 429s from both providers end as TranslationBlockedError', async () => {
  const backend = createBackend(undefined, {
    msKey: 'ms',
    gcKey: 'gc',
    quota: new InMemoryQuotaStore(),
  });

  await withFetch(
    (async () =>
      new Response('rate limited', {
        status: 429,
        statusText: 'Too Many Requests',
      })) as typeof fetch,
    async () => {
      // The first two 429s surface as QuotaExhaustedError and route to the overflow provider; the
      // circuit breaker trips on the third, and with no provider left the job is blocked.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await backend.translateBatch(['Hello'], 'en', 'hu');
        } catch (err) {
          if (err instanceof TranslationBlockedError) return;
          assert.ok(
            err instanceof QuotaExhaustedError,
            `unexpected error before the breaker tripped: ${err}`
          );
        }
      }
      assert.fail('the circuit breaker never tripped');
    }
  );
});

test("composite: the 'identity' name bypasses the providers entirely", async () => {
  const backend = createBackend('identity');
  assert.ok(backend instanceof IdentityBackend);
  assert.deepStrictEqual(await backend.translateBatch(['Hello'], 'en', 'hu'), ['Hello']);
});
