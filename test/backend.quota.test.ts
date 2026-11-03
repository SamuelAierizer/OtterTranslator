import { test } from 'node:test';
import assert from 'node:assert';
import { createBackend, PROVIDER_LIMITS } from '../src/engine/backends/index.ts';
import { InMemoryQuotaStore, currentMonth } from '../src/engine/quota.ts';
import { QuotaExhaustedError } from '../src/engine/errors.ts';

const MS = 'microsoft-translator';
const GC = 'google-cloud';

/** Stands in for the network: succeeds for whichever host the test allows. */
function fakeFetch(allow: { ms?: boolean; gc?: boolean }, seen: string[] = []) {
  return (async (url: string | URL) => {
    const href = url.toString();
    seen.push(href);

    if (href.includes('microsofttranslator') && allow.ms) {
      return new Response(JSON.stringify([{ translations: [{ text: 'ms-translated' }] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (href.includes('googleapis') && allow.gc) {
      return new Response(
        JSON.stringify({ data: { translations: [{ translatedText: 'gc-translated' }] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('nope', { status: 500, statusText: 'Internal Server Error' });
  }) as typeof fetch;
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('quota routing: the primary is used while it has budget', async () => {
  const quota = new InMemoryQuotaStore();
  const seen: string[] = [];
  const backend = createBackend(undefined, { msKey: 'ms', gcKey: 'gc', quota });

  await withFetch(fakeFetch({ ms: true }, seen), () =>
    backend.translateBatch(['Hello there'], 'en', 'hu')
  );

  assert.ok(
    seen.every((url) => url.includes('microsofttranslator')),
    'the overflow provider must not be touched while the primary has budget'
  );
  assert.strictEqual(await quota.getUsage(MS, currentMonth()), 'Hello there'.length);
  assert.strictEqual(await quota.getUsage(GC, currentMonth()), 0);
});

test('quota routing: an exhausted primary overflows to the secondary', async () => {
  const quota = new InMemoryQuotaStore();
  await quota.addUsage(MS, currentMonth(), PROVIDER_LIMITS[MS]);

  const seen: string[] = [];
  const backend = createBackend(undefined, { msKey: 'ms', gcKey: 'gc', quota });

  const result = await withFetch(fakeFetch({ gc: true }, seen), () =>
    backend.translateBatch(['Hello there'], 'en', 'hu')
  );

  assert.deepStrictEqual(result, ['gc-translated']);
  assert.ok(seen.every((url) => url.includes('googleapis')));
  assert.strictEqual(await quota.getUsage(GC, currentMonth()), 'Hello there'.length);
});

test('quota routing: both exhausted throws QuotaExhaustedError', async () => {
  const quota = new InMemoryQuotaStore();
  await quota.addUsage(MS, currentMonth(), PROVIDER_LIMITS[MS]);
  await quota.addUsage(GC, currentMonth(), PROVIDER_LIMITS[GC]);

  const backend = createBackend(undefined, { msKey: 'ms', gcKey: 'gc', quota });

  await withFetch(fakeFetch({}), () =>
    assert.rejects(() => backend.translateBatch(['Hello there'], 'en', 'hu'), QuotaExhaustedError)
  );
});

test('quota routing: usage persists across backend instances', async () => {
  const quota = new InMemoryQuotaStore();
  const text = 'Hello there';

  // Two separate composites, as a restart would produce, sharing one store.
  for (const _ of [0, 1]) {
    const backend = createBackend(undefined, { msKey: 'ms', gcKey: 'gc', quota });
    await withFetch(fakeFetch({ ms: true }), () => backend.translateBatch([text], 'en', 'hu'));
  }

  assert.strictEqual(
    await quota.getUsage(MS, currentMonth()),
    text.length * 2,
    'a fresh backend instance must not start the counter over'
  );
});

test('quota routing: an uncertain failed request retains its budget reservation', async () => {
  const quota = new InMemoryQuotaStore();
  const backend = createBackend(undefined, { msKey: 'ms', gcKey: 'gc', quota });

  await withFetch(fakeFetch({}), () =>
    assert.rejects(() => backend.translateBatch(['Hello there'], 'en', 'hu'))
  );

  assert.strictEqual(await quota.getUsage(MS, currentMonth()), 'Hello there'.length);
  assert.strictEqual(await quota.getUsage(GC, currentMonth()), 0);
});
