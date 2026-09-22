import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { translateDocx } from '../src/engine/index.ts';
import { TranslationBlockedError } from '../src/engine/errors.ts';
import type { TranslationBackend } from '../src/engine/backend.ts';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function documentText(buffer: Buffer): string {
  const xml = new AdmZip(buffer).readAsText('word/document.xml');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
}

/** Returns whatever the test dictates, regardless of input. */
function fixedBackend(reply: (text: string) => string): TranslationBackend {
  return {
    name: 'fixed',
    async translateBatch(texts: string[]) {
      return texts.map(reply);
    },
  };
}

// Two paragraphs, only one of which carries tags — so the mangling hits one and the document still
// completes, which is the behaviour under test. A fixture where every paragraph failed would trip
// the all-paragraphs-failed guard instead.
test('a tag-mangling translation keeps the source text instead of corrupting the paragraph', async () => {
  const input = fs.readFileSync(path.join(FIXTURES_DIR, 'text-box.docx'));
  const sourceText = documentText(input);

  const mismatches: string[] = [];
  const output = await translateDocx(input, {
    from: 'en',
    to: 'hu',
    verify: false,
    // Strips every bracket tag — the exact corruption validateTags exists to catch.
    backendImpl: fixedBackend((text) => text.replace(/\[\/?[^\]]+\]/g, '')),
    onTagMismatch: (blockId) => mismatches.push(blockId),
  });

  assert.ok(mismatches.length > 0, 'the substitution must be reported, not silent');
  assert.strictEqual(documentText(output), sourceText, 'source text must survive intact');
});

test('a document where every paragraph fails validation is rejected outright', async () => {
  const input = fs.readFileSync(path.join(FIXTURES_DIR, 'hyperlink.docx'));

  await assert.rejects(
    () =>
      translateDocx(input, {
        from: 'en',
        to: 'hu',
        verify: false,
        backendImpl: fixedBackend(() => 'total garbage [f99] with invented tags'),
      }),
    TranslationBlockedError
  );
});

test('a clean translation is written through unchanged', async () => {
  const input = fs.readFileSync(path.join(FIXTURES_DIR, 'mixed-runs.docx'));

  const mismatches: string[] = [];
  const output = await translateDocx(input, {
    from: 'en',
    to: 'hu',
    verify: false,
    backendImpl: fixedBackend((text) => text),
    onTagMismatch: (blockId) => mismatches.push(blockId),
  });

  assert.deepStrictEqual(mismatches, []);
  assert.strictEqual(documentText(output), documentText(input));
});
