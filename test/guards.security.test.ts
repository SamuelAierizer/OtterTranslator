import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { assertIsDocx, assertNoZipBomb, assertPartSize } from '../src/engine/guards.js';
import { DocumentTooLargeError, MalformedDocxError } from '../src/engine/errors.js';

function makeDocx(extra: Record<string, string> = {}): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'));
  for (const [name, content] of Object.entries(extra)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

test('assertIsDocx requires DOCX structural parts', () => {
  assert.doesNotThrow(() => assertIsDocx(makeDocx()));
  assert.throws(() => assertIsDocx(Buffer.from('not a zip')), MalformedDocxError);
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  assert.throws(() => assertIsDocx(zip.toBuffer()), MalformedDocxError);
});

test('assertNoZipBomb rejects excessive uncompressed data and ratios', () => {
  const zip = new AdmZip();
  zip.addFile('large.xml', Buffer.alloc(101 * 1024 * 1024));
  assert.throws(() => assertNoZipBomb(zip), DocumentTooLargeError);
});

test('assertPartSize rejects parts above 2 MiB', () => {
  assert.doesNotThrow(() => assertPartSize(2 * 1024 * 1024));
  assert.throws(() => assertPartSize(2 * 1024 * 1024 + 1), DocumentTooLargeError);
});

test('@xmldom/xmldom does not resolve external entities', () => {
  const dom = new DOMParser().parseFromString(
    '<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///etc/passwd">]><root>&secret;</root>',
    'application/xml'
  );
  assert.equal(dom.documentElement.textContent, '&secret;');
});

test('DocxHandler discovers footnotes and endnotes', async () => {
  const { DocxHandler } = await import('../src/engine/docx-handler.js');
  const parts = new DocxHandler(makeDocx({
    'word/footnotes.xml': '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/endnotes.xml': '<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    'word/comments.xml': '<w:comments/>',
  })).load();
  assert.deepEqual(parts.sort(), ['word/document.xml', 'word/endnotes.xml', 'word/footnotes.xml']);
});
