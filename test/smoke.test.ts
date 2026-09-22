import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { DocxHandler } from '../src/engine/docx-handler.js';
import { extractBlocksFromDOM } from '../src/engine/xml-parser.js';
import { reconstructParagraph } from '../src/engine/reconstructor.js';
import { translateDocx } from '../src/engine/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const fixtureNames = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.docx'));

/**
 * Asserts the buffer is a valid, openable DOCX: a well-formed zip containing
 * a well-formed word/document.xml part.
 */
function assertOpenableDocx(buffer: Buffer): void {
  const zip = new AdmZip(buffer);
  const documentEntry = zip.getEntry('word/document.xml');
  assert.ok(documentEntry, 'word/document.xml must be present');

  const xml = zip.readAsText('word/document.xml');
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const parserErrors = dom.getElementsByTagName('parsererror');
  assert.equal(parserErrors.length, 0, 'word/document.xml must be well-formed XML');
}

for (const fixtureName of fixtureNames) {
  test(`${fixtureName} round-trips through DocxHandler + xml-parser + reconstructor with an identity transform`, () => {
    const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, fixtureName));

    const docHandler = new DocxHandler(inputBuffer);
    const parts = docHandler.load();
    assert.ok(parts.includes('word/document.xml'));

    for (const part of parts) {
      const dom = docHandler.getDOM(part);
      const blocks = extractBlocksFromDOM(dom, part);
      for (const block of blocks) {
        // Identity "translation": reconstruct the paragraph from its own tagged text.
        reconstructParagraph(dom, block.wpNode, block.text, block.styleMap);
      }
    }

    const outputBuffer = docHandler.toBuffer();
    assertOpenableDocx(outputBuffer);
  });
}

test('translateDocx wires the full pipeline through to the not-yet-implemented backend/guard stubs', async () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'plain-paragraph.docx'));

  // guards.ts / tags.ts / backends/index.ts are intentionally left as
  // `throw new Error('not implemented: ...')` stubs for other agents to fill in.
  // This proves the orchestrator reaches them rather than silently skipping them.
  await assert.rejects(
    () => translateDocx(inputBuffer, { from: 'en', to: 'es' }),
    /not implemented/
  );
});
