# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
