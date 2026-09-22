import { test } from 'node:test';
import assert from 'node:assert';
import { verifyTranslations, needsReview, type ChatProvider } from '../src/engine/verify/index.ts';

/** Provider stub: replies with whatever the script says, never touching the network. */
function scriptedProvider(
  name: string,
  handler: (userMessage: string) => Promise<string> | string
): ChatProvider & { calls: number } {
  const provider = {
    name,
    calls: 0,
    async complete(_system: string, userMessage: string) {
      provider.calls++;
      return handler(userMessage);
    },
  };
  return provider;
}

function parsePairs(userMessage: string): Array<{ index: number; source: string; translation: string }> {
  const jsonLine = userMessage.split('\n').at(-1)!;
  return JSON.parse(jsonLine);
}

/** Echoes the stage-1 translations back, optionally transformed. */
function echoProvider(transform: (translation: string, index: number) => string) {
  return scriptedProvider('echo', (userMessage) => {
    const pairs = parsePairs(userMessage);
    return JSON.stringify({
      items: pairs.map((pair) => ({ index: pair.index, text: transform(pair.translation, pair.index) })),
    });
  });
}

const OPTS = { from: 'ro', to: 'hu' };

test('verify: a valid correction replaces the stage-1 text', async () => {
  const sources = ['[f1]Contractul[/f1] intră în vigoare la semnare.'];
  const stage1 = ['[f1]A szerzodes[/f1] a alairaskor lep hatalyba.'];
  const provider = echoProvider(() => '[f1]A szerződés[/f1] az aláíráskor lép hatályba.');

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.strictEqual(result.texts[0], '[f1]A szerződés[/f1] az aláíráskor lép hatályba.');
  assert.strictEqual(result.corrected, 1);
  assert.strictEqual(result.rejected, 0);
});

test('verify: a tag-mangling correction is rejected and stage-1 output survives', async () => {
  const sources = ['[f1]Contractul[/f1] intră în vigoare la [f2]semnare[/f2].[br/]'];
  const stage1 = ['[f1]A szerződés[/f1] az [f2]aláíráskor[/f2] lép hatályba.[br/]'];

  // Drops [f2]...[/f2] and the line break — exactly the silent corruption the guard exists for.
  const provider = echoProvider(() => '[f1]A szerződés[/f1] az aláíráskor lép hatályba.');

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.strictEqual(result.texts[0], stage1[0], 'stage-1 text must survive a tag mismatch');
  assert.strictEqual(result.rejected, 1);
  assert.strictEqual(result.corrected, 0);
});

test('verify: a wrong-length response is rejected for the whole batch', async () => {
  const sources = ['Prima propoziție de test.', 'A doua propoziție de test.'];
  const stage1 = ['Első teszt mondat.', 'Második teszt mondat.'];

  const provider = scriptedProvider('short', () =>
    JSON.stringify({ items: [{ index: 0, text: 'Csak egy elem.' }] })
  );

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.deepStrictEqual(result.texts, stage1);
  assert.strictEqual(result.corrected, 0);
});

test('verify: duplicate indices are treated as misalignment and discarded', async () => {
  const sources = ['Prima propoziție de test.', 'A doua propoziție de test.'];
  const stage1 = ['Első teszt mondat.', 'Második teszt mondat.'];

  const provider = scriptedProvider('dupe', () =>
    JSON.stringify({
      items: [
        { index: 0, text: 'Javított első.' },
        { index: 0, text: 'Javított második.' },
      ],
    })
  );

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.deepStrictEqual(result.texts, stage1);
});

test('verify: unparseable output leaves the document complete', async () => {
  const sources = ['Prima propoziție de test aici.'];
  const stage1 = ['Első teszt mondat itt.'];
  const provider = scriptedProvider('garbage', () => 'I am afraid I cannot do that.');

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.deepStrictEqual(result.texts, stage1);
});

test('verify: a provider timeout leaves the document complete', async () => {
  const sources = ['Prima propoziție de test aici.'];
  const stage1 = ['Első teszt mondat itt.'];
  const provider = scriptedProvider('dead', () => {
    throw new Error('request timed out');
  });

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.deepStrictEqual(result.texts, stage1);
  assert.strictEqual(result.skipped, 1);
});

test('verify: the second provider is used when the first fails', async () => {
  const sources = ['Prima propoziție de test aici.'];
  const stage1 = ['Első teszt mondat itt.'];

  const primary = scriptedProvider('cerebras', () => {
    throw new Error('429 rate limited');
  });
  const fallback = echoProvider(() => 'Javított teszt mondat itt.');

  const result = await verifyTranslations(sources, stage1, {
    ...OPTS,
    providers: [primary, fallback],
  });

  assert.strictEqual(primary.calls, 1);
  assert.strictEqual(fallback.calls, 1);
  assert.strictEqual(result.texts[0], 'Javított teszt mondat itt.');
});

test('verify: short, numeric and single-word paragraphs are never sent', async () => {
  assert.strictEqual(needsReview('42'), false);
  assert.strictEqual(needsReview('Contractul'), false);
  assert.strictEqual(needsReview('Da.'), false);
  assert.strictEqual(needsReview('[f1]2026[/f1]'), false);
  assert.strictEqual(needsReview('[o1/]'), false);
  assert.strictEqual(needsReview('Contractul intră în vigoare.'), true);

  const sources = ['42', 'Contractul intră în vigoare la semnare.'];
  const stage1 = ['42', 'A szerződés az aláíráskor lép hatályba.'];
  const provider = echoProvider((translation) => translation);

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider] });

  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(provider.calls, 1);
});

test('verify: no configured provider is a no-op, not a failure', async () => {
  const sources = ['Contractul intră în vigoare la semnare.'];
  const stage1 = ['A szerződés az aláíráskor lép hatályba.'];

  const result = await verifyTranslations(sources, stage1, { ...OPTS, providers: [] });

  assert.deepStrictEqual(result.texts, stage1);
});

test('verify: batches respect both the pair count and the character budget', async () => {
  const sources = Array.from({ length: 5 }, (_, i) => `Propoziția numărul ${i} din test.`);
  const stage1 = sources.map((_, i) => `A(z) ${i}. teszt mondat.`);

  const batchSizes: number[] = [];
  const provider = scriptedProvider('counter', (userMessage) => {
    const pairs = parsePairs(userMessage);
    batchSizes.push(pairs.length);
    return JSON.stringify({ items: pairs.map((p) => ({ index: p.index, text: p.translation })) });
  });

  await verifyTranslations(sources, stage1, { ...OPTS, providers: [provider], batchSize: 2 });
  assert.deepStrictEqual(batchSizes, [2, 2, 1]);

  batchSizes.length = 0;
  await verifyTranslations(sources, stage1, {
    ...OPTS,
    providers: [provider],
    batchSize: 20,
    maxBatchChars: 60,
  });
  assert.ok(batchSizes.length > 1, 'character budget must split the batch');
  assert.ok(
    batchSizes.every((size) => size >= 1),
    'no empty batches'
  );
});
