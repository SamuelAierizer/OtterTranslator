import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';
import { DocxHandler } from '../src/engine/docx-handler.js';
import { extractBlocksFromDOM } from '../src/engine/xml-parser.js';
import { reconstructParagraph } from '../src/engine/reconstructor.js';
import { validateTags, cleanTranslatedBrackets } from '../src/engine/tags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

test('hyperlink survives round-trip with container tags', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'hyperlink.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  const { wpNode, text, styleMap } = block;

  reconstructParagraph(dom, wpNode, text, styleMap);

  const serialized = (wpNode as any).toString();
  assert(serialized.includes('w:hyperlink'), 'reconstructed paragraph should contain hyperlink element');
  assert(serialized.includes('website'), 'text should be preserved');
});

test('image placeholder reconstructs to preserved run at same position', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'inline-image.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  reconstructParagraph(dom, block.wpNode, block.text, block.styleMap);

  const serialized = (block.wpNode as any).toString();
  assert(serialized.includes('w:drawing'), 'image should be reconstructed in the paragraph');
});

test('validateTags rejects dropped [br/]', () => {
  const source = 'Line one[br/]Line two[br/]Line three';
  const translated = 'Ligne un[br/]Ligne deux';

  assert.equal(validateTags(source, translated), false, 'should reject translation missing a line break');
});

test('validateTags rejects unbalanced [fN] tags', () => {
  const source = '[f1]text[/f1]';
  const translated = '[f1]texto';

  assert.equal(validateTags(source, translated), false, 'should reject unbalanced format tags');
});

test('validateTags rejects unbalanced [hN] container tags', () => {
  const source = '[h1]link[/h1]';
  const translated = '[h1]enlace';

  assert.equal(validateTags(source, translated), false, 'should reject unbalanced container tags');
});

test('validateTags rejects dropped [oN/] placeholders', () => {
  const source = 'Text with [o1/] image.';
  const translated = 'Texto con imagen.';

  assert.equal(validateTags(source, translated), false, 'should reject dropped object placeholder');
});

test('validateTags accepts valid translation with all tags', () => {
  const source = '[f1]bold[/f1] and [h1]link[/h1] with [o1/] image and [br/] break.';
  const translated = '[f1]negrita[/f1] y [h1]enlace[/h1] con [o1/] imagen y [br/] salto.';

  assert.equal(validateTags(source, translated), true, 'should accept valid translation with preserved tags');
});

test('cleanTranslatedBrackets removes spaces in format tags', () => {
  const input = '[ f1 ]text[ /f1 ]';
  const output = cleanTranslatedBrackets(input);
  assert.equal(output, '[f1]text[/f1]');
});

test('cleanTranslatedBrackets removes spaces in container tags', () => {
  const input = '[ h1 ]link[ /h1 ]';
  const output = cleanTranslatedBrackets(input);
  assert.equal(output, '[h1]link[/h1]');
});

test('cleanTranslatedBrackets removes spaces in object placeholders', () => {
  const input = 'Image: [ o1 / ]';
  const output = cleanTranslatedBrackets(input);
  assert.equal(output, 'Image: [o1/]');
});

test('cleanTranslatedBrackets removes spaces in line breaks', () => {
  const input = '[ br / ] and [ br/]';
  const output = cleanTranslatedBrackets(input);
  assert.equal(output, '[br/] and [br/]');
});

test('cleanTranslatedBrackets preserves legitimate [[ in content', () => {
  const input = 'Math: [[a, b]] notation';
  const output = cleanTranslatedBrackets(input);
  assert.equal(output, 'Math: [[a, b]] notation', 'should not mangle legitimate [[');
});
