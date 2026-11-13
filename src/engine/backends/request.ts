import { setTimeout as sleep } from 'node:timers/promises';
import { BackendTimeoutError, QuotaExhaustedError, TranslationBlockedError } from '../errors.js';

export function retryDelay(value: string | null | undefined, attempt: number, now = Date.now()): number {
  if (value != null) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 250 * 2 ** attempt;
}

export async function providerRequest(
  send: (signal: AbortSignal) => Promise<Response>, reserve: () => Promise<void>, signal?: AbortSignal
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    await reserve();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    let data: any;
    try {
      response = await send(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      try { data = await response.json(); } catch (err) {
        if (controller.signal.aborted || signal?.aborted) throw err;
        data = null;
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw new BackendTimeoutError('Translation request aborted or timed out');
      throw err;
    } finally { clearTimeout(timeout); }
    const error = data?.error;
    const message = typeof error?.message === 'string' ? error.message : '';
    const permanentQuota = Number(error?.code) === 403001 || /daily limit exceeded/i.test(message) || error?.errors?.some((e: any) => e.reason === 'dailyLimitExceeded');
    if (permanentQuota) throw new QuotaExhaustedError('Provider quota exhausted');
    const transient = response.status === 429 || (response.status === 403 && /user rate limit exceeded/i.test(message));
    if (transient) {
      if (attempt >= 2) throw new TranslationBlockedError('Provider rate limit persisted after three attempts');
      await sleep(retryDelay(response.headers?.get('Retry-After'), attempt), undefined, { signal });
      continue;
    }
    if (!response.ok) throw new Error(`Translation provider error: ${response.status}`);
    return data;
  }
}
