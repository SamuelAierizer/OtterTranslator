# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Resolve all remaining engine backlog findings: preserve note references, text boxes, content controls, field instructions, symbols, tabs and literal tag text.
- Send raw plain text to providers, repair spaced markers and restore source whitespace around breaks.
- Batch provider requests, split only between complete tags/Unicode characters, retry transient rate limits and pace Azure by characters in a sliding window.
- Keep one provider per document; only confirmed initial quota exhaustion triggers fallback.
- Align pnpm pins, refresh the multipart lockfile and verify a clean installation with current Corepack and Node 24.
- Preserve text order, formatting, line/page/column breaks and carriage returns when rebuilding paragraphs.
- Rebuild formatted hyperlink contents without leaking internal tags into visible text.
- Reject misaligned provider batches before translations shift into neighbouring paragraphs.
- Reject crossed, reversed or nested format tags and retain source paragraphs safely.
- Snapshot paragraph nodes before extraction to avoid repeated document traversal.
- Leave break-only paragraphs out of provider requests.

### Added
- Regression and deterministic property tests for paragraph fidelity, tag structure and batch alignment.
- [Translation engine findings](docs/findings.md), imported from Taiga's sandbox with open issues preserved.

## [0.1.1] - 2026-05-24

### Added
- TypeScript conversion from JavaScript
- General-purpose CLI with flexible language pair support
- Dual engine support (Google Translate default, Ollama optional)
- Configuration via CLI arguments (--from, --to, --engine, --model, --batch-size)
- Comprehensive type definitions in types.ts
- MIT License
- CONTRIBUTING.md guide
- Enhanced .gitignore

### Changed
- Renamed index.js to cli.ts with improved argument parsing
- Removed hardcoded Romanian→Hungarian language pair
- Made Google Translate the default engine (previously Ollama)
- Updated package.json with proper build scripts and CLI bin entry

### Removed
- All deprecated .js files (replaced by TypeScript versions)
- Unused type definitions (TranslationEngine, TranslationOptions, DocxPart, RunProperties)
- User-specific example files

### Fixed
- package.json main field pointing to non-existent index.js
- TypeScript compilation errors with proper type annotations

## [0.1.0] - 2026-05-23

### Added
- Initial release
- DOCX XML parsing and manipulation
- Ollama LLM translation support
- Run merging for split text runs
- Bracket tag system for formatting preservation
- Progress bar with ETA estimation
- Tag validation and error recovery
