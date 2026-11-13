import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { extractBlocksFromDOM } from '../src/engine/xml-parser.ts';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Typical Word output: every paragraph split into several same-format runs, which get merged. */
function documentWith(paragraphs: number): any {
  const run = (text: string) => `<w:r><w:rPr><w:lang w:val="ro-RO"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${run(`Paragraph ${i} `)}${run('split into ')}${run('several runs.')}</w:p>`
  ).join('');
  return new DOMParser().parseFromString(`<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`, 'application/xml');
}

// Regression (F-18): extraction iterated xmldom's live getElementsByTagName list. Each DOM change
// made by run merging forced the next `.length` read to re-walk the whole document, so extraction
// was quadratic: 2,000 paragraphs took ~27 s and blocked the server's event loop. Linear extraction
// does 3,000 paragraphs in well under a second; the bound leaves a wide margin for slow machines
// while staying far below the quadratic time (~45 s).
test('extraction time grows linearly with paragraph count', () => {
  const dom = documentWith(3000);
  const started = performance.now();
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');
  const elapsed = performance.now() - started;

  assert.equal(blocks.length, 3000);
  assert.ok(elapsed < 3000, `extracting 3,000 paragraphs took ${Math.round(elapsed)} ms`);
});

test('extraction keeps document order, ids and merged text', () => {
  const blocks = extractBlocksFromDOM(documentWith(50), 'word/document.xml');
  assert.equal(blocks.length, 50);
  blocks.forEach((block, i) => {
    assert.equal(block.id, `word/document.xml_p_${i}`);
    assert.equal(block.text, `Paragraph ${i} split into several runs.`);
    assert.equal(block.wpNode.getElementsByTagName('w:r').length, 1, 'same-format runs are merged');
  });
});
