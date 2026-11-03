/** Optional review transports; see docs/providers.md for current billing/privacy checks. */
import { BackendTimeoutError } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';

export interface ChatProvider {
  name: string;
  /** Returns the raw assistant message content, expected to be JSON matching `schema`. */
  complete(
    systemPrompt: string,
    userMessage: string,
    schema: unknown,
    signal?: AbortSignal
  ): Promise<string>;
}

export type FetchLike = typeof fetch;

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Provider requests per minute on the free tier. */
  requestsPerMinute: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  private readonly config: ProviderConfig;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    // maxBurst must be at least one whole request: the free tiers are slower than 1 req/sec, so a
    // bucket sized to `tokensPerSecond` would never hold enough for a single acquire(1).
    this.limiter = new RateLimiter({
      tokensPerSecond: config.requestsPerMinute / 60,
      maxBurst: 1,
    });
  }

  async complete(
    systemPrompt: string,
    userMessage: string,
    schema: unknown,
    signal?: AbortSignal
  ): Promise<string> {
    await this.limiter.acquire(1);
    if (signal?.aborted) throw new Error('Verification aborted');

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'translation_review', strict: true, schema },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${this.name} review failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`${this.name} review returned no message content`);
      }
      return content;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
        throw new BackendTimeoutError(`${this.name} review request timed out`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Build configured optional reviewers. Account limits and privacy controls need administrator verification. */
export function createVerifyProviders(fetchImpl?: FetchLike): ChatProvider[] {
  const providers: ChatProvider[] = [];

  if (process.env.CEREBRAS_API_KEY) {
    providers.push(
      new OpenAICompatibleProvider({
        name: 'cerebras',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKey: process.env.CEREBRAS_API_KEY,
        model: process.env.CEREBRAS_VERIFY_MODEL || 'gpt-oss-120b',
        requestsPerMinute: 5,
        fetchImpl,
      })
    );
  }

  if (process.env.GROQ_API_KEY) {
    providers.push(
      new OpenAICompatibleProvider({
        name: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_VERIFY_MODEL || 'openai/gpt-oss-120b',
        requestsPerMinute: 30,
        fetchImpl,
      })
    );
  }

  return providers;
}
