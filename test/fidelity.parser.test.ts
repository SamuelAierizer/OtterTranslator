import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from '@xmldom/xmldom';
import { DocxHandler } from '../src/engine/docx-handler.js';
import { extractBlocksFromDOM } from '../src/engine/xml-parser.js';
import { stripTags, validateTags } from '../src/engine/tags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

test('hyperlink.docx serializes container text and preserves position', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'hyperlink.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  assert.equal(blocks.length, 1);
  const block = blocks[0];

  const cleanText = stripTags(block.text);
  assert(cleanText.includes('Visit our'));
  assert(cleanText.includes('website'));
  assert(cleanText.includes('for more info.'));

  const websitePos = block.text.indexOf('website');
  assert(websitePos > 0, 'hyperlinked word should be in the text');
});

test('hyperlink.docx preserves r:id in container metadata', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'hyperlink.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  const hTags = block.text.match(/\[h\d+\]/g) || [];
  assert(hTags.length > 0, 'hyperlink should emit container tags');

  const containerId = hTags[0].match(/\d+/)![0];
  const containerMeta = block.styleMap.get(`h${containerId}`);
  assert(containerMeta, 'container metadata should exist');
  assert.equal(containerMeta.nodeName, 'w:hyperlink');
  assert(containerMeta.attributes['r:id'], 'r:id should be preserved');
});

test('inline-image.docx emits object placeholder mid-sentence', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'inline-image.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  const cleanText = stripTags(block.text);

  assert(cleanText.includes('Look at this'));
  assert(cleanText.includes('image, mid sentence.'));

  const oPlaceholders = block.text.match(/\[o\d+\/\]/g) || [];
  assert.equal(oPlaceholders.length, 1, 'should have one object placeholder');

  const hasImageBetweenText = /Look at this\s+\[o\d+\/\]\s+image/.test(block.text);
  assert(hasImageBetweenText, 'image placeholder should be between text, not at end');
});

test('image placeholder metadata contains originalNode clone', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'inline-image.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  const oTags = block.text.match(/\[o(\d+)\/\]/g) || [];

  for (const tag of oTags) {
    const id = tag.match(/\d+/)![0];
    const metadata = block.styleMap.get(`o${id}`);
    assert(metadata, `metadata for o${id} should exist`);
    assert.equal(metadata.nodeName, 'preserved-run');
    assert(metadata.originalNode, 'originalNode should be stored');
  }
});

test('sdt.docx serializes SDT container text', () => {
  const inputBuffer = fs.readFileSync(path.join(FIXTURES_DIR, 'sdt.docx'));
  const docHandler = new DocxHandler(inputBuffer);
  const parts = docHandler.load();

  const dom = docHandler.getDOM('word/document.xml');
  const blocks = extractBlocksFromDOM(dom, 'word/document.xml');

  const block = blocks[0];
  const cleanText = stripTags(block.text);

  assert(cleanText.includes('Paragraph with'));
  assert(cleanText.includes('inline content control'));
  assert(cleanText.includes('text.'));

  const hTags = block.text.match(/\[h\d+\]/g) || [];
  assert(hTags.length > 0, 'SDT should emit container tags');
});
