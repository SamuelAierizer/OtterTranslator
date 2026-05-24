# DOCX High-Fidelity Translation Pipeline

A professional-grade, layout-preserving document translation system for Microsoft Word documents (`.docx`). Translates text while preserving formatting, structure, styles, tables, headers, footers, and nested elements.

**Dual Engine Support:**
- **Google Translate (Default)**: Lightning-fast, high-quality translation using the free public API. No credentials required.
- **Local Ollama**: For offline privacy or custom model support (requires Ollama server).

**Language Agnostic**: Supports any language pair (e.g., English→Spanish, Romanian→Hungarian, French→German, etc.).

---

## Features

- **High-Fidelity Formatting Preservation**: Bold, italic, underline, fonts, colors, and styles are preserved exactly
- **Structure Preservation**: Tables, lists, headers, footers, and nested elements remain intact
- **Run Merging**: Automatically merges split text runs (e.g., `[Spu]`, `[berit]` → `[Spuberit]`) before translation
- **Grammar-Safe Tag Tracking**: Uses lightweight bracket tags (`[f1]...[/f1]`, `[br/]`) that the translation engine can reposition correctly for different word orders
- **Drawing & Image Preservation**: Layout elements, drawings, and images are protected and preserved
- **Real-Time Progress**: Beautiful progress bar with ETA estimation
- **Error Recovery**: Automatic retries and fallbacks for translation errors
- **Batch Processing**: High-speed concurrent translation for fast processing

---

## Installation

```bash
npm install
```

### Build (for distribution)

```bash
npm run build
```

---

## Usage

### Basic Usage (Google Translate - Recommended)

Translate from English to Spanish:

```bash
npm run build
node dist/cli.js input.docx output.docx --from en --to es
```

Or using the dev mode (no build required):

```bash
npm run dev -- input.docx output.docx --from en --to es
```

### Using Local Ollama

Translate using a local Ollama model:

```bash
npm run dev -- input.docx output.docx --from ro --to hu --ollama --model qwen2.5:7b
```

Or simply:

```bash
npm run dev -- input.docx output.docx --ollama
```

The system will auto-detect available Ollama models and prioritize `qwen2.5:7b`, then `gemma4:latest`, then the first available model.

### CLI Options

```
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
```

---

## Architecture

The system uses an **unzip → XML DOM mutate → zip** architecture:

```
                    ┌────────────────────────┐
                    │      input.docx         │
                    └───────────┬────────────┘
                                │ (adm-zip)
                                ▼
                   ┌──────────────────────────┐
                   │      docx-handler.ts     │ (Reads XML elements)
                   └────────────┬─────────────┘
                                │ document.xml, headers, footers
                                ▼
                   ┌──────────────────────────┐
                   │       xml-parser.ts      │ (Normalizes runs & tags text)
                   └────────────┬─────────────┘
                                │ Inline tags: [f1]text[/f1], [br/]
                                ▼
         ┌──────────────────────┴──────────────────────┐
         │                                              │
         ▼                                              ▼
┌──────────────────────┐                   ┌──────────────────────┐
│  google-translator.ts│                   │  ollama-translator.ts │
│  (Free, Fast)        │                   │  (Local, Private)    │
└──────────┬───────────┘                   └──────────┬───────────┘
           │                                          │
           └──────────────────┬───────────────────────┘
                              │ Translated text with intact tags
                              ▼
                   ┌──────────────────────────┐
                   │     reconstructor.ts     │ (Parses tags back to DOCX DOM)
                   └────────────┬─────────────┘
                                │ DOM Reconstruction
                                ▼
                    ┌────────────────────────┐
                    │     output.docx        │ (Saves zipped file)
                    └────────────────────────┘
```

---

## Technical Details

### Tag System

The system uses lightweight bracket tags to preserve formatting:

- **Formatting tags**: `[f1]...[/f1]`, `[f2]...[/f2]`, etc. - Wrap text with specific formatting
- **Line breaks**: `[br/]` - Represents line breaks within paragraphs

These tags are:
1. **Preserved by translation engines**: Both Google Translate and Ollama are instructed to keep these tags unchanged
2. **Repositionable**: Since different languages have different word orders, the tags can move to wrap the correct translated words
3. **Cleaned automatically**: Google Translate sometimes adds spaces inside brackets; the system cleans these automatically

### Run Merging

Word documents often have "split runs" where a single word is split across multiple text nodes (e.g., `[Spu]`, `[berit]` instead of `[Spuberit]`). The parser automatically merges consecutive runs with identical formatting before translation to ensure accurate results.

### Error Handling

- **Tag Validation**: After translation, the system validates that all formatting tags are present and balanced
- **Automatic Retries**: If validation fails, the system retries with stricter instructions
- **Fallback**: If retries fail, a stripped-text translation is used as a final fallback

---

## Development

### Project Structure

```
src/
├── types.ts              # TypeScript type definitions
├── docx-handler.ts       # DOCX zip management and XML parsing
├── xml-parser.ts         # XML parsing, run merging, and tag serialization
├── google-translator.ts  # Google Translate API client
├── ollama-translator.ts  # Ollama LLM client with batch processing
├── reconstructor.ts      # Tag parsing and DOCX DOM reconstruction
└── cli.ts                # Main CLI interface
```

### Building

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### Running in Development Mode

```bash
npm run dev -- [args]
```

This uses `tsx` to run TypeScript directly without building.

---

## License

MIT

---

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.
