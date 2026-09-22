import type AdmZip from 'adm-zip';

/**
 * Input-validation guards for the translation pipeline.
 */

export function assertIsDocx(buf: Buffer): void {
  throw new Error('not implemented: assertIsDocx');
}

export function assertNoZipBomb(zip: AdmZip): void {
  throw new Error('not implemented: assertNoZipBomb');
}

export function assertPartSize(bytes: number): void {
  throw new Error('not implemented: assertPartSize');
}
