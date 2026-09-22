#!/usr/bin/env node
import fs from 'fs';
import { translateDocx } from './engine/index.js';
import type { CLIOptions } from './engine/types.js';

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
  currentPart: string
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

  const stats = `[${current}/${total}] [${percentage}%] [Elapsed: ${formatDuration(elapsed)} | ETA: ${formatDuration(remainingTime)}]`;
  const partInfo = `Part: ${currentPart}`;

  process.stdout.write(`${bar} ${stats} | ${partInfo}`);
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
      exitCli(0);
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
 * cli.ts is the only place in this codebase allowed to terminate the process.
 */
function exitCli(code: number): never {
  process.exit(code);
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
    exitCli(1);
  }

  if (!fs.existsSync(options.input)) {
    console.error(`[Error] Input file not found at: ${options.input}`);
    exitCli(1);
  }

  console.log(`Using translation engine: "Google Translate (Hybrid, high-fidelity, lightning-fast)"`);
  console.log(`Language pair: ${options.from!.toUpperCase()} → ${options.to!.toUpperCase()}`);
  console.log(`\nInitializing translation:`);
  console.log(`Source File: ${options.input}`);
  console.log(`Output File: ${options.output}`);
  console.log('----------------------------------------------------');

  const inputBuffer = fs.readFileSync(options.input);
  const startTime = Date.now();

  try {
    const outputBuffer = await translateDocx(inputBuffer, {
      from: options.from || DEFAULT_FROM,
      to: options.to || DEFAULT_TO,
      onProgress: (done, total, part) => printProgressBar(done, total, startTime, part)
    });

    fs.writeFileSync(options.output, outputBuffer);

    console.log('\n\n----------------------------------------------------');
    console.log(`Success! High-fidelity translated document saved to:`);
    console.log(`👉 ${options.output}`);
  } catch (err: any) {
    console.error(`\n[Fatal Error] Translation failed:`, err.message);
    exitCli(1);
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`Total processing time: ${formatDuration(totalElapsed)}`);
  console.log('====================================================');
}

main().catch((err: Error) => {
  console.error('[Unhandled Exception]:', err);
  exitCli(1);
});
