# Contributing to DOCX Translation Pipeline

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd <repository>
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Run in development mode**
   ```bash
   npm run dev -- input.docx output.docx --from en --to es
   ```

## Code Style

- Use TypeScript for all new code
- Follow existing code formatting
- Add type annotations for all functions and parameters
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

## Project Structure

```
src/
├── cli.ts                # Main CLI interface
├── docx-handler.ts       # DOCX zip management
├── google-translator.ts  # Google Translate API
├── ollama-translator.ts  # Ollama LLM client
├── reconstructor.ts      # DOCX DOM reconstruction
├── types.ts              # Core type definitions
└── xml-parser.ts         # XML parsing & run merging
```

## Testing

Before submitting a pull request:
1. Ensure the project builds successfully: `npm run build`
2. Test your changes with sample DOCX files
3. Verify TypeScript compilation produces no errors

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes with clear messages
4. Push to your fork: `git push origin feature/my-feature`
5. Open a pull request with a description of your changes

## Areas for Contribution

- Additional translation engines (DeepL, Azure, etc.)
- Test suite and unit tests
- Configuration file support
- Batch file processing
- Translation caching
- Documentation improvements
- Bug fixes and performance improvements

## Questions?

Feel free to open an issue for questions or discussion about potential contributions.
