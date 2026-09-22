import { test } from 'node:test';
import assert from 'node:assert';
import { OpenAICompatibleProvider } from '../src/engine/verify/provider.ts';
import { BackendTimeoutError } from '../src/engine/errors.ts';
import { REVIEW_RESPONSE_SCHEMA } from '../src/engine/verify/prompt.ts';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('provider: sends a strict json_schema request and returns the message content', async () => {
  let captured: any;

  const provider = new OpenAICompatibleProvider({
    name: 'cerebras',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'gpt-oss-120b',
    requestsPerMinute: 600,
    fetchImpl: async (url, init) => {
      captured = { url, body: JSON.parse((init as RequestInit).body as string), init };
      return jsonResponse({ choices: [{ message: { content: '{"items":[]}' } }] });
    },
  });

  const content = await provider.complete('system', 'user', REVIEW_RESPONSE_SCHEMA);

  assert.strictEqual(content, '{"items":[]}');
  assert.strictEqual(captured.url, 'https://api.example.test/v1/chat/completions');
  assert.strictEqual(captured.body.model, 'gpt-oss-120b');
  assert.strictEqual(captured.body.response_format.type, 'json_schema');
  assert.strictEqual(captured.body.response_format.json_schema.strict, true);
  assert.strictEqual(captured.init.headers.Authorization, 'Bearer test-key');
});

test('provider: a non-ok response throws rather than returning garbage', async () => {
  const provider = new OpenAICompatibleProvider({
    name: 'groq',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'openai/gpt-oss-120b',
    requestsPerMinute: 600,
    fetchImpl: async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
  });

  await assert.rejects(() => provider.complete('system', 'user', REVIEW_RESPONSE_SCHEMA), /429/);
});

test('provider: an exceeded timeout surfaces as BackendTimeoutError', async () => {
  const provider = new OpenAICompatibleProvider({
    name: 'cerebras',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'gpt-oss-120b',
    requestsPerMinute: 600,
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });

  await assert.rejects(
    () => provider.complete('system', 'user', REVIEW_RESPONSE_SCHEMA),
    BackendTimeoutError
  );
});

test("provider: the caller's abort signal is honoured and not reported as a timeout", async () => {
  const controller = new AbortController();

  const provider = new OpenAICompatibleProvider({
    name: 'cerebras',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
    model: 'gpt-oss-120b',
    requestsPerMinute: 600,
    timeoutMs: 10_000,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });

  const pending = provider.complete('system', 'user', REVIEW_RESPONSE_SCHEMA, controller.signal);
  controller.abort();

  await assert.rejects(() => pending, (err: Error) => {
    assert.ok(!(err instanceof BackendTimeoutError), 'caller abort is not a timeout');
    return true;
  });
});
