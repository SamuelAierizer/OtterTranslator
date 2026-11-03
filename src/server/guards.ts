import { DOMParser } from '@xmldom/xmldom';
import { assertPartSize } from '../engine/guards.js';
import { DocxHandler } from '../engine/docx-handler.js';
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024; // 2 MB
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK..

export async function validateUpload(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024} MB.`);
  }

  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(DOCX_MAGIC)) {
    throw new Error('File is not a valid DOCX document.');
  }

  const handler = new DocxHandler(buffer);
  handler.load();
  const zip = handler.getZip();
  const entry = zip.getEntry('[Content_Types].xml')!;
  assertPartSize(entry.header.size);
  const xml = zip.readAsText(entry);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid DOCX content types');
  let invalid = false;
  const dom = new DOMParser({ onError: () => { invalid = true; } }).parseFromString(xml, 'application/xml');
  const types = Array.from(dom.getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override'));
  if (invalid || !types.some(t => t.getAttribute('PartName') === '/word/document.xml' && t.getAttribute('ContentType') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') || zip.getEntry('word/vbaProject.bin')) throw new Error('File must be a DOCX document without macros');
  return 'docx';
}
