/**
 * Error types for the DOCX translation engine.
 */

export class TranslationBlockedError extends Error {
  code = 'TRANSLATION_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'TranslationBlockedError';
  }
}

export class DocumentTooLargeError extends Error {
  code = 'DOCUMENT_TOO_LARGE';

  constructor(message: string) {
    super(message);
    this.name = 'DocumentTooLargeError';
  }
}

export class MalformedDocxError extends Error {
  code = 'MALFORMED_DOCX';

  constructor(message: string) {
    super(message);
    this.name = 'MalformedDocxError';
  }
}

export class BackendTimeoutError extends Error {
  code = 'BACKEND_TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'BackendTimeoutError';
  }
}

export class QuotaExhaustedError extends Error {
  code = 'QUOTA_EXHAUSTED';

  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
