import { XMLSerializer } from '@xmldom/xmldom';
import { DocxHandler } from './docx-handler.js';
import { extractBlocksFromDOM } from './xml-parser.js';
import { reconstructParagraph } from './reconstructor.js';
import { assertIsDocx, assertNoZipBomb, assertPartSize } from './guards.js';
import { validateTags } from './tags.js';
import { createBackend } from './backends/index.js';
import { verifyTranslations } from './verify/index.js';
import { TranslationBlockedError } from './errors.js';
import type { TranslateOptions } from './types.js';

const serializer = new XMLSerializer();
const DEFAULT_BACKEND = process.env.TRANSLATION_BACKEND || 'google';

/**
 * Full translate-a-DOCX pipeline: guard -> unzip -> extract -> translate -> reconstruct -> rezip.
 * This is the single entry point the server (and the CLI) call into.
 *
 * Batching (chunk size, char budgets, concurrency) is the backend's responsibility, not the
 * orchestrator's: the full block-text array is handed to `translateBatch` in one call so each
 * backend can size its own batches (e.g. a character-budget batcher for a paid API's per-request
 * limits) instead of being forced through a fixed chunk size here.
 */
export async function translateDocx(buffer: Buffer, opts: TranslateOptions): Promise<Buffer> {
  assertIsDocx(buffer);

  const docHandler = new DocxHandler(buffer);
  const parts = docHandler.load();
  assertNoZipBomb(docHandler.getZip());

  for (const part of parts) {
    assertPartSize(Buffer.byteLength(serializer.serializeToString(docHandler.getDOM(part))));
  }

  const allBlocks = [];
  for (const part of parts) {
    const dom = docHandler.getDOM(part);
    const partBlocks = extractBlocksFromDOM(dom, part);
    allBlocks.push(...partBlocks);
  }

  const total = allBlocks.length;
  const backend =
    opts.backendImpl ?? createBackend(opts.backend ?? DEFAULT_BACKEND, { quota: opts.quota });
  const texts = allBlocks.map((block) => block.text);
  let translatedTexts = await backend.translateBatch(texts, opts.from, opts.to, opts.signal);

  // Stage 2: optional LLM review pass. Fails open by construction — `verifyTranslations` returns
  // the stage-1 text for anything it cannot safely improve, so the document completes regardless.
  if (opts.verify !== false) {
    const reviewed = await verifyTranslations(texts, translatedTexts, {
      from: opts.from,
      to: opts.to,
      providers: opts.verifyProviders,
      signal: opts.signal,
    });
    translatedTexts = reviewed.texts;
  }

  let tagMismatches = 0;

  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i];
    const translatedText = translatedTexts[i];

    // A translation that mangled its formatting tags would reconstruct into corrupted markup, so
    // the paragraph keeps its source text instead. Failing the whole document over one bad
    // paragraph is worse — but so is substituting silently, hence the callback.
    let finalText = translatedText;
    if (!validateTags(block.text, translatedText)) {
      finalText = block.text;
      tagMismatches++;
      opts.onTagMismatch?.(block.id, block.partName);
    }

    const dom = docHandler.getDOM(block.partName);
    reconstructParagraph(dom, block.wpNode, finalText, block.styleMap);
    opts.onProgress?.(i + 1, total, block.partName);
  }

  // Isolated mismatches are tolerable; every paragraph failing means the backend returned something
  // systematically wrong, and the "translated" document would be the untouched source. Fail loudly.
  if (total > 0 && tagMismatches === total) {
    throw new TranslationBlockedError(
      `Every paragraph failed tag validation (${total}); the backend returned unusable output`
    );
  }

  return docHandler.toBuffer();
}
