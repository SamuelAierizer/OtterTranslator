/**
 * Stage 2: an LLM review-and-correct pass over the stage-1 machine translation.
 *
 * The rule that makes a silent auto-correction layer shippable: **the verifier may only improve,
 * never corrupt.** Corrections are invisible to the user, so a verifier that quietly mangles
 * formatting is strictly worse than no verifier at all. Every returned string is re-checked with
 * `validateTags` against its source, and anything that fails — bad tags, wrong array length,
 * misaligned indices, unparseable JSON, a dead provider — falls back to the stage-1 text for the
 * affected paragraphs. There is deliberately no bypass.
 */

import { validateTags } from '../tags.js';
import { createVerifyProviders, type ChatProvider } from './provider.js';
import {
  REVIEW_SYSTEM_PROMPT,
  REVIEW_RESPONSE_SCHEMA,
  buildReviewUserMessage,
  type ReviewPair,
} from './prompt.js';

export { createVerifyProviders, OpenAICompatibleProvider } from './provider.js';
export type { ChatProvider } from './provider.js';

export interface VerifyOptions {
  from: string;
  to: string;
  /** Providers tried in order. Defaults to Cerebras then Groq, from the environment. */
  providers?: ChatProvider[];
  /** Maximum pairs per request. */
  batchSize?: number;
  /** Maximum source+translation characters per request; keeps batches inside the context cap. */
  maxBatchChars?: number;
  signal?: AbortSignal;
  onProgress?: (reviewed: number, total: number) => void;
}

export interface VerifyResult {
  /** Same length and order as the input translations. */
  texts: string[];
  /** Paragraphs the model actually changed. */
  corrected: number;
  /** Paragraphs that came back but were rejected by the tag guard. */
  rejected: number;
  /** Paragraphs never sent (too short, numeric, or no provider available). */
  skipped: number;
}

const DEFAULT_BATCH_SIZE = 20;
/** Cerebras' free tier caps context at 8,192 tokens; this keeps a batch well inside it. */
const DEFAULT_MAX_BATCH_CHARS = 8_000;
const MIN_REVIEWABLE_LENGTH = 15;

/**
 * Paragraphs with no real prose to review — pure numbers, a single word, or very short strings.
 * Skipping them is a meaningful call-volume reduction for no quality loss.
 */
export function needsReview(text: string): boolean {
  const stripped = text.replace(/\[\/?[^\]]+\]/g, '').trim();
  if (stripped.length < MIN_REVIEWABLE_LENGTH) return false;
  if (!/\p{L}/u.test(stripped)) return false;
  if (!/\s/.test(stripped)) return false;
  return true;
}

interface Candidate {
  /** Position in the original `translations` array. */
  position: number;
  pair: ReviewPair;
}

function packBatches(candidates: Candidate[], batchSize: number, maxChars: number): Candidate[][] {
  const batches: Candidate[][] = [];
  let current: Candidate[] = [];
  let currentChars = 0;

  for (const candidate of candidates) {
    const cost = candidate.pair.source.length + candidate.pair.translation.length;
    if (current.length > 0 && (current.length >= batchSize || currentChars + cost > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(candidate);
    currentChars += cost;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Parses a review response into one corrected string per batch entry.
 * Returns `null` if the response is unusable as a whole — the caller then keeps stage-1 output for
 * the entire batch rather than guessing which entries were meant for which paragraph.
 */
function parseReviewResponse(raw: string, expected: number): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length !== expected) return null;

  const byIndex = new Array<string | undefined>(expected);
  for (const item of items) {
    const index = (item as { index?: unknown })?.index;
    const text = (item as { text?: unknown })?.text;
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    if (index < 0 || index >= expected) return null;
    if (typeof text !== 'string') return null;
    if (byIndex[index] !== undefined) return null; // duplicate index — alignment is not trustworthy
    byIndex[index] = text;
  }

  if (byIndex.some((entry) => entry === undefined)) return null;
  return byIndex as string[];
}

/**
 * Reviews stage-1 output. Never throws on provider trouble: a document must complete even when the
 * optional quality pass does not.
 */
export async function verifyTranslations(
  sources: string[],
  translations: string[],
  opts: VerifyOptions
): Promise<VerifyResult> {
  if (sources.length !== translations.length) {
    throw new Error('verifyTranslations: sources and translations must be the same length');
  }

  const texts = [...translations];
  const result: VerifyResult = { texts, corrected: 0, rejected: 0, skipped: 0 };

  const providers = opts.providers ?? createVerifyProviders();
  const candidates: Candidate[] = [];

  for (let i = 0; i < sources.length; i++) {
    if (needsReview(sources[i])) {
      candidates.push({ position: i, pair: { source: sources[i], translation: translations[i] } });
    } else {
      result.skipped++;
    }
  }

  if (providers.length === 0 || candidates.length === 0) {
    result.skipped = sources.length;
    return result;
  }

  const batches = packBatches(
    candidates,
    opts.batchSize ?? DEFAULT_BATCH_SIZE,
    opts.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS
  );

  let reviewed = 0;

  for (const batch of batches) {
    if (opts.signal?.aborted) break;

    const userMessage = buildReviewUserMessage(
      batch.map((candidate) => candidate.pair),
      opts.from,
      opts.to
    );

    let corrections: string[] | null = null;
    for (const provider of providers) {
      try {
        const raw = await provider.complete(
          REVIEW_SYSTEM_PROMPT,
          userMessage,
          REVIEW_RESPONSE_SCHEMA,
          opts.signal
        );
        corrections = parseReviewResponse(raw, batch.length);
        if (corrections) break;
      } catch {
        // Provider down, rate-limited, or timed out: try the next one, then give up on this batch.
      }
    }

    if (!corrections) {
      result.skipped += batch.length;
    } else {
      for (let i = 0; i < batch.length; i++) {
        const candidate = batch[i];
        const corrected = corrections[i];

        if (!validateTags(candidate.pair.source, corrected)) {
          result.rejected++;
          continue;
        }
        if (corrected === candidate.pair.translation) continue;

        texts[candidate.position] = corrected;
        result.corrected++;
      }
    }

    reviewed += batch.length;
    opts.onProgress?.(reviewed, candidates.length);
  }

  return result;
}
