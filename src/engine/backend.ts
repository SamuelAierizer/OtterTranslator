/**
 * Contract every translation backend (Google, Ollama, etc.) must implement.
 */
export interface TranslationBackend {
  name: string;
  translateBatch(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]>;
}
