import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { translateDocx } from '../src/engine/index.ts';
import { TranslationBlockedError } from '../src/engine/errors.ts';
import type { TranslationBackend } from '../src/engine/backend.ts';

/** A document of `count` one-line paragraphs: "Para 0", "Para 1", ... */
function paragraphsDocx(count: number): Buffer {
  const body = Array.from({ length: count }, (_, i) => `<w:p><w:r><w:t>Para ${i}</w:t></w:r></w:p>`).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.addFile('word/document.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  ));
  return zip.toBuffer();
}

/** Translates correctly, except that `reshape` may change the size of the array for a given call. */
function backend(reshape: (call: number, translated: string[]) => string[]): TranslationBackend & { calls: number } {
  return {
    name: 'reshaping',
    calls: 0,
    async translateBatch(texts: string[]) {
      this.calls++;
      return reshape(this.calls, texts.map((text) => text.replace('Para', 'Bekezdés')));
    },
  };
}

// Regression: only the grand total used to be checked. A batch one short followed by a batch one
// long passed that check, and every later paragraph silently received its neighbour's translation.
test('a short batch followed by a long batch fails instead of shifting text into neighbouring paragraphs', async () => {
  const reshaping = backend((call, out) => (call === 1 ? out.slice(0, -1) : [...out, 'Extra']));

  await assert.rejects(
    () => translateDocx(paragraphsDocx(16), { from: 'en', to: 'hu', verify: false, backendImpl: reshaping }),
    TranslationBlockedError
  );
});

test('a batch with the wrong number of results stops the job before more provider calls are spent', async () => {
  const reshaping = backend((call, out) => (call === 1 ? [...out, 'Extra'] : out));

  await assert.rejects(
    () => translateDocx(paragraphsDocx(24), { from: 'en', to: 'hu', verify: false, backendImpl: reshaping }),
    TranslationBlockedError
  );
  assert.equal(reshaping.calls, 1, 'no further batches are sent after a misaligned one');
});

test('correctly sized batches still translate every paragraph in place', async () => {
  const output = await translateDocx(paragraphsDocx(17), {
    from: 'en',
    to: 'hu',
    verify: false,
    backendImpl: backend((_call, out) => out),
  });
  const xml = new AdmZip(output).readAsText('word/document.xml');
  const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  assert.deepEqual(texts, Array.from({ length: 17 }, (_, i) => `Bekezdés ${i}`));
});

test('a backend that returns something other than an array is rejected', async () => {
  // A 3-character string for 3 paragraphs has the right length; spreading it would hand each
  // paragraph a single character as its "translation".
  const broken: TranslationBackend = {
    name: 'broken',
    async translateBatch() {
      return 'abc' as unknown as string[];
    },
  };
  await assert.rejects(
    () => translateDocx(paragraphsDocx(3), { from: 'en', to: 'hu', verify: false, backendImpl: broken }),
    TranslationBlockedError
  );
});
