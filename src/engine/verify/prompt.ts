/**
 * Stage-2 review prompt and response schema.
 *
 * The prompt is deliberately constant: quality has to stay consistent across documents even on a
 * small model, so only the language pair and the payload vary. Do not make it configurable.
 */

export interface ReviewPair {
  /** Source-language text, tags included. */
  source: string;
  /** Stage-1 machine translation of `source`, tags included. */
  translation: string;
}

export const REVIEW_SYSTEM_PROMPT = [
  'You are a translation reviewer. You are given numbered pairs of a source text and its machine',
  'translation. For each pair, check the translation against the source: verify the core message',
  'survived, that terminology and tone are consistent, and correct any mistranslation, omission or',
  'grammatical error.',
  '',
  'The texts contain bracket tags that carry document formatting: [f1]...[/f1] (formatting runs),',
  '[h1]...[/h1] (hyperlinks and similar containers), [o1/] (inline images and objects) and [br/]',
  '(line breaks). These are not content. Reproduce every tag from the machine translation exactly',
  'as-is: same spelling, same numbers, same count, wrapping the corresponding translated words.',
  'Never add, drop, renumber or reword a tag.',
  '',
  'Return one entry per input pair, with the same index, in the same order. If a translation is',
  'already correct, return it unchanged. Output only the translated text — no commentary, no',
  'explanation of what you changed.',
].join('\n');

/** JSON schema for strict structured output. Every field required, no extra properties. */
export const REVIEW_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['index', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

export function buildReviewUserMessage(pairs: ReviewPair[], from: string, to: string): string {
  const payload = pairs.map((pair, index) => ({
    index,
    source: pair.source,
    translation: pair.translation,
  }));

  return [
    `Source language: ${from}. Target language: ${to}.`,
    `Review these ${pairs.length} pairs and return ${pairs.length} entries.`,
    JSON.stringify(payload),
  ].join('\n');
}
