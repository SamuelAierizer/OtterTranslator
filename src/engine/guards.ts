import type AdmZip from 'adm-zip';
import AdmZipConstructor from 'adm-zip';
import { DocumentTooLargeError, MalformedDocxError } from './errors.js';

/**
 * Input-validation guards for the translation pipeline.
 */

export function assertIsDocx(buf: Buffer): void {
  try {
    const zip = new AdmZipConstructor(buf);
    const hasContentTypes = Boolean(zip.getEntry('[Content_Types].xml'));
    const hasDocument = Boolean(zip.getEntry('word/document.xml'));
    if (!hasContentTypes || !hasDocument) {
      throw new MalformedDocxError('DOCX archive is missing required parts');
    }
  } catch (error) {
    if (error instanceof MalformedDocxError) throw error;
    throw new MalformedDocxError('Input is not a valid DOCX archive');
  }
}

export function assertNoZipBomb(zip: AdmZip): void {
  const maxUncompressedBytes = 100 * 1024 * 1024;
  const maxCompressionRatio = 100;
  let totalUncompressed = 0;

  for (const entry of zip.getEntries()) {
    const uncompressed = entry.header.size;
    const compressed = entry.header.compressedSize;
    totalUncompressed += uncompressed;
    if (
      totalUncompressed > maxUncompressedBytes ||
      (uncompressed > 0 && compressed === 0) ||
      (uncompressed > 0 && uncompressed / Math.max(compressed, 1) > maxCompressionRatio)
    ) {
      throw new DocumentTooLargeError('DOCX archive exceeds safe decompression limits');
    }
  }
}

export function assertPartSize(bytes: number): void {
  // xmldom DOM memory is roughly 5–15x source size; 2 MiB keeps peak usage below ~30 MiB per part.
  const maxPartBytes = 2 * 1024 * 1024;
  if (bytes > maxPartBytes) {
    throw new DocumentTooLargeError('DOCX XML part exceeds safe parsing limits');
  }
}
