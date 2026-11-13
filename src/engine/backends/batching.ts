import { TranslationBlockedError } from '../errors.js';

/** Split only between complete internal tags or Unicode code points. */
export function splitTaggedText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const token of text.match(/\[(?:\/?[fh]\d+|o\d+\/|br\/)\]|[^]/gu) ?? []) {
    if (token.length > limit) throw new TranslationBlockedError('Formatting token exceeds request limit');
    if (current.length + token.length > limit) { chunks.push(current); current = ''; }
    current += token;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function translatePacked(
  texts: string[], limit: number, maxItems: number,
  request: (texts: string[]) => Promise<Array<string | undefined>>, signal?: AbortSignal
): Promise<string[]> {
  const results = texts.map(() => '');
  let batch: Array<{ text: string; index: number }> = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    signal?.throwIfAborted();
    const translated = await request(batch.map(item => item.text));
    if (!Array.isArray(translated) || translated.length !== batch.length || translated.some(t => typeof t !== 'string' || !t)) {
      throw new TranslationBlockedError('Provider returned an incomplete translation');
    }
    batch.forEach((item, i) => {
      // Keep chunk-edge whitespace so splitting cannot join neighbouring words.
      results[item.index] += (item.text.match(/^\s*/)?.[0] ?? '') + translated[i]!.trim() + (item.text.match(/\s*$/)?.[0] ?? '');
    });
    batch = []; size = 0;
  };
  for (let index = 0; index < texts.length; index++) {
    if (!texts[index].trim()) { results[index] = texts[index]; continue; }
    for (const text of splitTaggedText(texts[index], limit)) {
      if (size + text.length > limit || batch.length >= maxItems) await flush();
      batch.push({ text, index }); size += text.length;
    }
  }
  await flush();
  return results;
}
