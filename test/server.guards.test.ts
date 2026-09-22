import { test } from 'node:test';
import assert from 'node:assert';
import { validateUpload } from '../src/server/guards.ts';

test('guards: reject file too large', async () => {
  const largeBuffer = Buffer.alloc(3 * 1024 * 1024); // 3 MB
  largeBuffer[0] = 0x50;
  largeBuffer[1] = 0x4b;
  largeBuffer[2] = 0x03;
  largeBuffer[3] = 0x04;

  try {
    await validateUpload(largeBuffer);
    assert.fail('Should throw on large file');
  } catch (err: any) {
    assert.match(err.message, /too large/i);
  }
});

test('guards: reject non-docx file', async () => {
  const invalidBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header

  try {
    await validateUpload(invalidBuffer);
    assert.fail('Should throw on invalid format');
  } catch (err: any) {
    assert.match(err.message, /not a valid DOCX/i);
  }
});

test('guards: accept valid docx header', async () => {
  const validBuffer = Buffer.alloc(100);
  validBuffer[0] = 0x50;
  validBuffer[1] = 0x4b;
  validBuffer[2] = 0x03;
  validBuffer[3] = 0x04;

  const result = await validateUpload(validBuffer);
  assert.strictEqual(result, 'docx');
});

test('guards: reject empty file', async () => {
  const emptyBuffer = Buffer.alloc(0);

  try {
    await validateUpload(emptyBuffer);
    assert.fail('Should throw on empty file');
  } catch (err: any) {
    assert.match(err.message, /not a valid DOCX/i);
  }
});
