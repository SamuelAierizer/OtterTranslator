const MAX_UPLOAD_SIZE = 2 * 1024 * 1024; // 2 MB
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK..

export async function validateUpload(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large. Maximum size is ${MAX_UPLOAD_SIZE / 1024 / 1024} MB.`);
  }

  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(DOCX_MAGIC)) {
    throw new Error('File is not a valid DOCX document.');
  }

  return 'docx';
}
