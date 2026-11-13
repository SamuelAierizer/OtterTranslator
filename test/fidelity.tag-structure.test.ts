import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { validateTags } from '../src/engine/tags.ts';
import { translateDocx } from '../src/engine/index.ts';
import type { TranslationBackend } from '../src/engine/backend.ts';

// Regression (F-17): validateTags only compared tag counts and ids. The tags form a nested-bracket
// language, so order matters: these replies have the right tags in a broken structure, and each
// one used to be accepted and silently misapply formatting or links.
const SOURCE = '[f1]bold[/f1] plain [f2]italic[/f2] see [h1]link[/h1][br/]end [o1/]';

const broken: Record<string, string> = {
  'closer before its opener': '[/f1]félkövér[f1] sima [f2]dőlt[/f2] lásd [h1]link[/h1][br/]vége [o1/]',
  'crossed format runs': '[f1]félkövér [f2]sima[/f1] dőlt[/f2] lásd [h1]link[/h1][br/]vége [o1/]',
  'closers swapped between runs': '[f1]félkövér[/f2] sima [f2]dőlt[/f1] lásd [h1]link[/h1][br/]vége [o1/]',
  'format run nested inside another': '[f1]félkövér [f2]dőlt[/f2][/f1] sima lásd [h1]link[/h1][br/]vége [o1/]',
  'link closed before it opens': '[f1]félkövér[/f1] sima [f2]dőlt[/f2] lásd [/h1]link[h1][br/]vége [o1/]',
  'format run crossing a link boundary': '[f1]félkövér[/f1] sima [f2]dőlt lásd [h1]link[/f2][/h1][br/]vége [o1/]',
};

for (const [name, reply] of Object.entries(broken)) {
  test(`validateTags rejects a reply with the right tags in a broken structure: ${name}`, () => {
    assert.equal(validateTags(SOURCE, reply), false);
  });
}

// Order-aware validation must not cost translations: translators legitimately reorder words, so
// any well-formed arrangement of the same tags is still accepted.
const legitimate: Record<string, string> = {
  'same order': '[f1]félkövér[/f1] sima [f2]dőlt[/f2] lásd [h1]link[/h1][br/]vége [o1/]',
  'format runs swapped in word order': '[f2]dőlt[/f2] sima [f1]félkövér[/f1] lásd [h1]link[/h1][br/]vége [o1/]',
  'link moved to the start': '[h1]link[/h1] [f1]félkövér[/f1] sima [f2]dőlt[/f2][br/]vége [o1/]',
  'break and object moved': '[o1/] [f1]félkövér[/f1] sima[br/] [f2]dőlt[/f2] lásd [h1]link[/h1] vége',
  'format run moved inside the link': 'félkövér sima [f2]dőlt[/f2] lásd [h1][f1]link[/f1][/h1][br/]vége [o1/]',
  'link wrapped by a format run': 'sima [f2]dőlt[/f2] lásd [f1]félkövér [h1]link[/h1][/f1][br/]vége [o1/]',
  'break and object inside runs and links': '[f1]fél[br/]kövér[/f1] sima [f2]dőlt[/f2] lásd [h1]li[o1/]nk[/h1] vége',
};

for (const [name, reply] of Object.entries(legitimate)) {
  test(`validateTags accepts a well-formed rearrangement: ${name}`, () => {
    assert.equal(validateTags(SOURCE, reply), true);
  });
}

test('nested containers must close innermost first', () => {
  const source = '[h1]outer [h2]inner[/h2] text[/h1]';
  assert.equal(validateTags(source, '[h1]külső [h2]belső[/h2] szöveg[/h1]'), true);
  assert.equal(validateTags(source, '[h1]külső [h2]belső[/h1] szöveg[/h2]'), false);
});

test('a structurally broken reply keeps the paragraph in source with its formatting intact', async () => {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> plain</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  ));
  // Swaps the first paragraph's bold opener and closer; translates the second one correctly.
  const backend: TranslationBackend = {
    name: 'swapping',
    async translateBatch(texts: string[]) {
      return texts.map((text) => text === '[f1]bold[/f1] plain' ? '[/f1]félkövér[f1] sima' : 'Második bekezdés.');
    },
  };
  const mismatches: string[] = [];
  const output = await translateDocx(zip.toBuffer(), {
    from: 'en', to: 'hu', verify: false, backendImpl: backend, onTagMismatch: (id) => mismatches.push(id),
  });

  assert.deepEqual(mismatches, ['word/document.xml_p_0'], 'the broken paragraph is reported');
  const dom = new DOMParser().parseFromString(new AdmZip(output).readAsText('word/document.xml'), 'application/xml');
  const runs = Array.from(dom.getElementsByTagName('w:r')).map((r: any) =>
    `${r.getElementsByTagName('w:b').length ? 'B:' : ''}${r.getElementsByTagName('w:t')[0]?.textContent}`);
  assert.deepEqual(runs, ['B:bold', ' plain', 'Második bekezdés.'], 'bold stays on "bold"; the other paragraph is translated');
});
