#!/usr/bin/env node
import path from 'path';
import fs from 'fs';
import ollama from 'ollama';
import { DocxHandler } from './docx-handler.js';
import { extractBlocksFromDOM } from './xml-parser.js';
import { OllamaTranslator } from './ollama-translator.js';
import { reconstructParagraph } from './reconstructor.js';
import { translateTextGoogle } from './google-translator.js';
import { CLIOptions } from './types.js';

// Default configuration
const DEFAULT_FROM = 'en';
const DEFAULT_TO = 'es';
const DEFAULT_BATCH_SIZE = 15;

/**
 * Format milliseconds into human-readable duration (MM:SS)
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Renders a high-fidelity console progress bar with ETA estimation
 */
function printProgressBar(
  current: number,
  total: number,
  startTime: number,
  currentPart: string,
  currentBlockText: string
): void {
  const width = 30;
  const percentage = Math.min(100, Math.floor((current / total) * 100));
  const completedWidth = Math.floor((percentage / 100) * width);
  const remainingWidth = width - completedWidth;

  const bar = '█'.repeat(completedWidth) + '░'.repeat(remainingWidth);
  
  const elapsed = Date.now() - startTime;
  const avgTimePerBlock = current > 0 ? elapsed / current : 0;
  const estimatedTotalTime = avgTimePerBlock * total;
  const remainingTime = Math.max(0, estimatedTotalTime - elapsed);

  // Clear current line and move cursor to start
  process.stdout.write('\r\x1b[K');
  
  // Format info string
  const stats = `[${current}/${total}] [${percentage}%] [Elapsed: ${formatDuration(elapsed)} | ETA: ${formatDuration(remainingTime)}]`;
  const partInfo = `Part: ${currentPart}`;
  
  process.stdout.write(`${bar} ${stats} | ${partInfo}`);
  
  // Print preview of the block text underneath if long
  if (currentBlockText) {
    const cleanPreview = currentBlockText.replace(/\[[^\]]+\]/g, '').substring(0, 50).trim();
    if (cleanPreview.length > 0) {
      process.stdout.write(`\n\x1b[K  Translating: "${cleanPreview}..."\x1b[1A`);
    }
  }
}

/**
 * Parse CLI arguments
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  
  const options: CLIOptions = {
    input: '',
    output: '',
    from: DEFAULT_FROM,
    to: DEFAULT_TO,
    engine: 'google',
    model: undefined,
    batchSize: DEFAULT_BATCH_SIZE
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      console.log(`
DOCX High-Fidelity Translation Pipeline

Usage:
  docx-translate <input.docx> <output.docx> [options]

Options:
  --from <lang>      Source language code (default: en)
  --to <lang>        Target language code (default: es)
  --engine <engine>  Translation engine: 'google' (default) or 'ollama'
  --model <model>    Ollama model name (e.g., qwen2.5:7b, gemma4:latest)
  --batch-size <n>   Batch size for translation (default: 15)
  --ollama           Shortcut for --engine ollama
  --help, -h         Show this help message

Examples:
  docx-translate input.docx output.docx --from en --to es
  docx-translate input.docx output.docx --from ro --to hu
  docx-translate input.docx output.docx --engine ollama --model qwen2.5:7b
  docx-translate input.docx output.docx --ollama
      `);
      process.exit(0);
    }
    
    if (arg === '--ollama') {
      options.engine = 'ollama';
    } else if (arg === '--from' && args[i + 1]) {
      options.from = args[++i];
    } else if (arg === '--to' && args[i + 1]) {
      options.to = args[++i];
    } else if (arg === '--engine' && args[i + 1]) {
      options.engine = args[++i] as 'google' | 'ollama';
    } else if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    } else if (arg === '--batch-size' && args[i + 1]) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (!options.input) {
      options.input = arg;
    } else if (!options.output) {
      options.output = arg;
    }
  }

  return options;
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  console.log('====================================================');
  console.log('       DOCX HIGH-FIDELITY TRANSLATION PIPELINE       ');
  console.log('====================================================\n');

  const options = parseArgs();

  if (!options.input || !options.output) {
    console.error('[Error] Input and output file paths are required.');
    console.error('Usage: docx-translate <input.docx> <output.docx> [options]');
    console.error('Run --help for more information.');
    process.exit(1);
  }

  if (!fs.existsSync(options.input)) {
    console.error(`[Error] Input file not found at: ${options.input}`);
    process.exit(1);
  }

  let translator: OllamaTranslator | null = null;
  let selectedModel: string | undefined = options.model;

  if (options.engine === 'ollama') {
    // Detect available Ollama models
    try {
      const listResponse = await ollama.list();
      const models = listResponse.models.map((m: any) => m.name);
      
      console.log('Detected local Ollama models:');
      models.forEach((m: string) => console.log(` - ${m}`));
      
      if (selectedModel) {
        if (models.includes(selectedModel)) {
          console.log(`\nUsing requested Ollama model: "${selectedModel}"`);
        } else {
          const fuzzyMatch = models.find((m: string) => m.toLowerCase().includes(selectedModel!.toLowerCase()));
          selectedModel = fuzzyMatch || selectedModel;
          console.log(`\nUsing matched Ollama model: "${selectedModel}"`);
        }
      } else {
        // Auto-detect: qwen2.5:7b -> gemma4:latest -> first available
        if (models.includes('qwen2.5:7b')) {
          selectedModel = 'qwen2.5:7b';
          console.log(`\nAuto-detected and using high-speed model: "${selectedModel}"`);
        } else if (models.includes('gemma4:latest')) {
          selectedModel = 'gemma4:latest';
          console.log(`\nUsing default model found: "${selectedModel}"`);
        } else if (models.length > 0) {
          selectedModel = models[0];
          console.log(`\nFalling back to first available model: "${selectedModel}"`);
        } else {
          throw new Error('No models found in Ollama');
        }
      }
      translator = new OllamaTranslator(selectedModel);
    } catch (err: any) {
      console.error(`\n[Ollama Error] Could not connect to local Ollama server.`);
      console.error('Please make sure Ollama is running (`ollama serve`) or use the default Google Translate engine.');
      process.exit(1);
    }
  } else {
    console.log(`Using translation engine: "Google Translate (Hybrid, high-fidelity, lightning-fast)"`);
    console.log(`Language pair: ${options.from!.toUpperCase()} → ${options.to!.toUpperCase()}`);
    console.log('To use local AI models instead, append the "--ollama" flag.');
  }

  console.log(`\nInitializing translation:`);
  console.log(`Source File: ${options.input}`);
  console.log(`Output File: ${options.output}`);
  console.log('----------------------------------------------------');

  const docHandler = new DocxHandler(options.input);
  const parts = docHandler.load();
  console.log(`Successfully unpacked DOCX. Found ${parts.length} structural XML components.`);

  // 1. Extract all blocks from all XML components
  const allBlocks = [];
  for (const part of parts) {
    const dom = docHandler.getDOM(part);
    const partBlocks = extractBlocksFromDOM(dom, part);
    allBlocks.push(...partBlocks);
  }

  const totalBlocks = allBlocks.length;
  console.log(`Total blocks to translate: ${totalBlocks}`);
  console.log('Starting translation pipeline...');
  console.log('----------------------------------------------------');

  const startTime = Date.now();
  let completedCount = 0;

  // Print initial empty line for preview offset
  console.log('');

  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;

  // 2. Iterate and translate in high-speed batches
  for (let i = 0; i < allBlocks.length; i += batchSize) {
    const chunk = allBlocks.slice(i, i + batchSize);
    
    // Update progress bar with the first item in the batch
    printProgressBar(completedCount, totalBlocks, startTime, chunk[0].partName, chunk[0].text);

    try {
      let translatedTexts: string[];

      if (options.engine === 'ollama' && translator) {
        const texts = chunk.map(block => block.text);
        translatedTexts = await translator.translateBatch(texts, batchSize);
      } else {
        // Run Google Translate in high-speed concurrent batch
        translatedTexts = await Promise.all(
          chunk.map(async (block) => {
            return await translateTextGoogle(block.text, options.from || DEFAULT_FROM, options.to || DEFAULT_TO);
          })
        );
        // Small rate limit protection delay
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Reconstruct and update paragraphs inside parent DOMs
      for (let j = 0; j < chunk.length; j++) {
        const block = chunk[j];
        const translatedText = translatedTexts[j];
        const dom = docHandler.getDOM(block.partName);
        reconstructParagraph(dom, block.wpNode, translatedText, block.styleMap);
      }

    } catch (err: any) {
      console.error(`\n[Fatal Error] Batch translation failed starting at block index ${i}:`, err.message);
      console.log('Saving intermediate progress to prevent lost work...');
      docHandler.save(options.output);
      process.exit(1);
    }

    completedCount += chunk.length;
  }

  // Clear preview line and print final status
  printProgressBar(totalBlocks, totalBlocks, startTime, 'Done', '');
  console.log('\n\n----------------------------------------------------');
  console.log('Translation complete! Saving file...');

  try {
    docHandler.save(options.output);
    console.log(`\nSuccess! High-fidelity translated document saved to:`);
    console.log(`👉 ${options.output}`);
  } catch (err: any) {
    console.error(`\n[Error] Failed saving output file:`, err.message);
    process.exit(1);
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`Total processing time: ${formatDuration(totalElapsed)}`);
  console.log('====================================================');
}

main().catch((err: Error) => {
  console.error('[Unhandled Exception]:', err);
  process.exit(1);
});
