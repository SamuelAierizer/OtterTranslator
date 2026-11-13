import { XMLSerializer } from '@xmldom/xmldom';
import { DocxHandler } from './docx-handler.js';
import { extractBlocksFromDOM } from './xml-parser.js';
import { reconstructParagraph } from './reconstructor.js';
import { assertIsDocx, assertNoZipBomb, assertPartSize } from './guards.js';
import { validateTags, normalizeTranslation } from './tags.js';
import { createBackend } from './backends/index.js';
import { verifyTranslations } from './verify/index.js';
import { TranslationBlockedError } from './errors.js';
import type { TranslateOptions } from './types.js';

const serializer = new XMLSerializer();


/**
 * Full translate-a-DOCX pipeline: guard -> unzip -> extract -> translate -> reconstruct -> rezip.
 * This is the single entry point the server (and the CLI) call into.
 *
 * The orchestrator provides bounded batches for progress and alignment checks; backends pack
 * those paragraphs into provider requests with their own character and item limits.
 */
export async function translateDocx(buffer: Buffer, opts: TranslateOptions): Promise<Buffer> {
  opts.onStage?.('validating', 2);
  if (opts.signal?.aborted) throw new Error('Translation aborted');
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
    opts.backendImpl ?? createBackend(opts.backend ?? process.env.TRANSLATION_BACKEND ?? 'composite', { quota: opts.quota });
  const texts = allBlocks.map((block) => block.text);
  opts.onStage?.('translating', 5);
  const translatedTextsResult: string[] = [];
  // Bound batches also provide honest progress while provider calls are in flight.
  for (let i = 0; i < texts.length; i += 8) {
    const batch = texts.slice(i, i + 8);
    const translatedBatch = await backend.translateBatch(batch, opts.from, opts.to, opts.signal);
    // Results are matched to paragraphs by position, so every batch must come back exactly the
    // size it went out. Checking only the grand total would let a short batch and a long batch
    // cancel out and shift translations into neighbouring paragraphs. Stop before spending more.
    if (!Array.isArray(translatedBatch) || translatedBatch.length !== batch.length) {
      throw new TranslationBlockedError('Provider returned an incomplete translation');
    }
    translatedTextsResult.push(...translatedBatch);
    opts.onStage?.('translating', 5 + Math.round(65 * Math.min(i + 8, texts.length) / texts.length));
  }
  let translatedTexts = translatedTextsResult;

  // Stage 2: optional LLM review pass. Fails open by construction — `verifyTranslations` returns
  // the stage-1 text for anything it cannot safely improve, so the document completes regardless.
  if (opts.verify !== false) {
    opts.onStage?.('reviewing', 75);
    const reviewed = await verifyTranslations(texts, translatedTexts, {
      from: opts.from,
      to: opts.to,
      providers: opts.verifyProviders,
      signal: opts.signal,
    });
    translatedTexts = reviewed.texts;
  }

  opts.onStage?.('reconstructing', 90);
  if (opts.signal?.aborted) throw new Error('Translation aborted');
  if (translatedTexts.length !== total) throw new TranslationBlockedError('Provider returned an incomplete translation');
  let tagMismatches = 0;

  // Descendants must be updated before an enclosing drawing run is cloned back into its parent.
  for (let i = allBlocks.length - 1; i >= 0; i--) {
    const block = allBlocks[i];
    const translatedText = normalizeTranslation(block.text, translatedTexts[i]);

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
    opts.onProgress?.(total - i, total, block.partName);
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
