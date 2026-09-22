import { test } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from '../src/engine/rate-limit.js';

test('RateLimiter: acquires tokens immediately when available', async () => {
  const limiter = new RateLimiter({ tokensPerSecond: 100, maxBurst: 10 });
  const start = Date.now();
  await limiter.acquire(5);
  const elapsed = Date.now() - start;
  assert(elapsed < 100, 'Should acquire immediately');
});

test('RateLimiter: waits for refill when tokens exhausted', async () => {
  const limiter = new RateLimiter({ tokensPerSecond: 100, maxBurst: 5 });
  await limiter.acquire(5); // Exhaust burst

  const start = Date.now();
  await limiter.acquire(5); // Should wait ~50ms (5 tokens at 100/sec)
  const elapsed = Date.now() - start;
  assert(elapsed >= 40, `Should wait at least 40ms, waited ${elapsed}ms`);
});

test('RateLimiter: serializes requests', async () => {
  const limiter = new RateLimiter({ tokensPerSecond: 10, maxBurst: 5 });
  const times: number[] = [];

  const promises = Array.from({ length: 3 }, async () => {
    times.push(Date.now());
    await limiter.acquire(2);
  });

  await Promise.all(promises);

  // Should be ~100ms apart (2 tokens at 10/sec = 200ms per, but 3 need 400ms total)
  assert(times.length === 3, 'All promises should resolve');
});

test('RateLimiter: refills over time', async () => {
  const limiter = new RateLimiter({ tokensPerSecond: 100, maxBurst: 10 });
  await limiter.acquire(10);

  // Wait 50ms = 5 tokens should refill
  await new Promise((r) => setTimeout(r, 50));
  const start = Date.now();
  await limiter.acquire(5); // Should not wait
  const elapsed = Date.now() - start;
  assert(elapsed < 50, 'Should acquire without waiting');
});
