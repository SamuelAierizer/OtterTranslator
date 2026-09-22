import ollama from 'ollama';

export class OllamaTranslator {
  private modelName: string;
  private systemPrompt: string;

  constructor(modelName: string = 'gemma2:9b', systemPrompt: string = '', private from = 'Romanian', private to = 'Hungarian') {
    this.modelName = modelName;
    this.systemPrompt = systemPrompt || 
      `You are an expert professional translator from ${this.from} to ${this.to}.

CRITICAL INSTRUCTIONS:
1. Translate the ${this.from} text to ${this.to}.
2. Preserve ALL format placeholders like '[f1]...[/f1]' or '[br/]' in your translation exactly.
3. The placeholders MUST wrap the grammatically correct corresponding terms in Hungarian. Do not drop, modify, or translate the text inside the brackets (e.g., '[f1]' must remain '[f1]', never '[f_szam]' or '[1]').
4. Output ONLY the raw translated Hungarian text. 
5. NEVER include conversational preambles, comments, notes, markdown backticks, or explanations.
6. If the input contains only symbols, numbers, or whitespace, return it exactly as is.`;
  }

  /**
   * Validate that the translated text contains the exact same set of bracket IDs as the source.
   */
  validateTags(sourceText: string, translatedText: string): boolean {
    const idRegex = /\[(f\d+)\]/g;
    
    const sourceIds: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(sourceText)) !== null) {
      sourceIds.push(match[1]);
    }

    const translatedIds: string[] = [];
    while ((match = idRegex.exec(translatedText)) !== null) {
      translatedIds.push(match[1]);
    }

    // Sort to compare sets
    sourceIds.sort();
    translatedIds.sort();

    const isMatch = sourceIds.length === translatedIds.length && 
                    sourceIds.every((val, index) => val === translatedIds[index]);

    // Check if tag structures are balanced and closed properly
    const openTags = (translatedText.match(/\[f\d+\]/g) || []).length;
    const closeTags = (translatedText.match(/\[\/f\d+\]/g) || []).length;
    const isBalanced = openTags === closeTags;

    return isMatch && isBalanced;
  }

  /**
   * Translates a batch of texts using Ollama's high-speed JSON mode
   */
  async translateBatch(texts: string[], batchSize: number = 15): Promise<string[]> {
    const results = new Array(texts.length);
    const translatableIndices: number[] = [];
    const translatableTexts: string[] = [];

    // Filter which elements actually need translating to save tokens and time
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (!text || text.trim() === '') {
        results[i] = '';
      } else if (!/\p{L}/u.test(text)) {
        // Only symbols/numbers
        results[i] = text;
      } else {
        translatableIndices.push(i);
        translatableTexts.push(text);
      }
    }

    if (translatableTexts.length === 0) {
      return results;
    }

    // Split translatable texts into chunks/batches
    for (let b = 0; b < translatableTexts.length; b += batchSize) {
      const chunkTexts = translatableTexts.slice(b, b + batchSize);
      const chunkIndices = translatableIndices.slice(b, b + batchSize);

      let success = false;
      let attempt = 0;
      const retries = 2;

      while (!success && attempt <= retries) {
        try {
          const response = await ollama.chat({
            model: this.modelName,
            format: 'json', // Force structured JSON output
            messages: [
              {
                role: 'system',
                content: `You are an expert professional translator from ${this.from} to ${this.to}.
Translate this JSON array of ${this.from} strings into ${this.to}.

CRITICAL INSTRUCTIONS:
1. Translate the strings accurately and professionally into Hungarian.
2. Preserve ALL format placeholders like '[f1]...[/f1]' or '[br/]' in your translations exactly.
3. The placeholders MUST wrap the grammatically correct corresponding terms in Hungarian. Do not drop, modify, or translate the tag ids (keep '[f1]' exactly as '[f1]').
4. Keep the exact index alignment. Output a JSON array of strings of size exactly ${chunkTexts.length}.
5. Return ONLY a valid JSON array of strings: ["translation1", "translation2", ...]
6. DO NOT write any explanations, side notes, or conversational comments. Do NOT use markdown codeblocks. Return only the raw JSON array.`
              },
              {
                role: 'user',
                content: JSON.stringify(chunkTexts)
              }
            ],
            options: {
              temperature: 0.1,
              num_predict: 4096
            }
          });

          let rawContent = response.message.content.trim();
          
          // Clean up markdown codeblocks if present
          if (rawContent.includes('```')) {
            rawContent = rawContent.replace(/```[a-zA-Z]*\n?/g, '').replace(/```$/g, '').trim();
          }

          let parsed: any;
          try {
            parsed = JSON.parse(rawContent);
          } catch (parseErr: any) {
            throw parseErr;
          }
          
          let parsedArray: string[] | null = null;

          if (Array.isArray(parsed)) {
            parsedArray = parsed;
          } else if (parsed && typeof parsed === 'object') {
            // Find any property in the object that is an array of the correct length
            const arrayKey = Object.keys(parsed).find((key: string) => 
              Array.isArray(parsed[key]) && parsed[key].length === chunkTexts.length
            );
            if (arrayKey) {
              parsedArray = parsed[arrayKey];
            }
          }

          if (parsedArray && parsedArray.length === chunkTexts.length) {
            // Validate tags on each item in the chunk
            let chunkAllValid = true;
            for (let i = 0; i < chunkTexts.length; i++) {
              if (!this.validateTags(chunkTexts[i], parsedArray[i])) {
                chunkAllValid = false;
                break;
              }
            }

            if (chunkAllValid) {
              for (let i = 0; i < chunkTexts.length; i++) {
                results[chunkIndices[i]] = parsedArray[i];
              }
              success = true;
            } else {
              console.warn(`[Warning] Tag validation failed inside batch chunk. Retrying chunk...`);
              attempt++;
            }
          } else {
            console.warn(`[Warning] Invalid batch format or length. Expected ${chunkTexts.length}. Retrying...`);
            attempt++;
          }
        } catch (err: any) {
          console.warn(`[Warning] Error translating batch chunk (attempt ${attempt + 1}):`, err.message);
          attempt++;
        }
      }

      // Fallback: If chunk failed after retries, translate each block in this chunk individually
      if (!success) {
        console.warn(`[Fallback] Batch chunk failed. Translating ${chunkTexts.length} blocks individually...`);
        for (let i = 0; i < chunkTexts.length; i++) {
          results[chunkIndices[i]] = await this.translateBlock(chunkTexts[i]);
        }
      }
    }

    return results;
  }

  /**
   * Translates a single text block using Ollama
   */
  async translateBlock(text: string, retries: number = 2): Promise<string> {
    if (!text || text.trim() === '') return '';

    // If text has no letters/words, don't waste LLM time
    if (!/\p{L}/u.test(text)) {
      return text;
    }

    let attempt = 0;
    while (attempt <= retries) {
      try {
        const response = await ollama.chat({
          model: this.modelName,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: text }
          ],
          options: {
            temperature: 0.1, // Low temperature for high deterministic translation and tag safety
            num_predict: 2048
          }
        });

        let result = response.message.content.trim();

        // Clean up common LLM wrap hallucinations (e.g. wrapping in ```json ... ``` or extra quotes)
        if (result.startsWith('```')) {
          result = result.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();
        }
        if (result.startsWith('"') && result.endsWith('"') && !text.startsWith('"')) {
          result = result.slice(1, -1).trim();
        }

        // Validate tags
        if (this.validateTags(text, result)) {
          return result;
        }

        console.warn(`[Warning] Tag validation failed on attempt ${attempt + 1} for text: "${text}". Got: "${result}"`);
        attempt++;
      } catch (err: any) {
        console.error(`[Error] Ollama connection error on attempt ${attempt + 1}:`, err.message);
        attempt++;
        if (attempt > retries) throw err;
      }
    }

    // Fallback: If tag validation fails after all retries, return a "safe" strip-tagged translation
    // to prevent total failure.
    console.warn(`[Fallback] Using stripped translation fallback for block.`);
    return this.translateWithStrippedTags(text);
  }

  /**
   * Strip tags, translate clean text, and wrap entire translation in the first tag as a fallback
   */
  async translateWithStrippedTags(text: string): Promise<string> {
    // Strip square bracket tags
    const cleanText = text.replace(/\[\/?[^\]]+\]/g, '');
    try {
      const response = await ollama.chat({
        model: this.modelName,
        messages: [
          { role: 'system', content: `Translate this ${this.from} text to ${this.to}. Output ONLY the translated text with NO explanations, notes, or quotes.` },
          { role: 'user', content: cleanText }
        ],
        options: { temperature: 0.1 }
      });
      let result = response.message.content.trim();
      
      // Attempt a best-effort tag re-wrap if there are tags in original
      const match = text.match(/\[(f\d+)\]/);
      if (match) {
        const idAttr = match[1];
        return `[${idAttr}]${result}[/${idAttr}]`;
      }
      return result;
    } catch (e: any) {
      console.error(`[Fallback Error] Failed translating stripped text:`, e);
      return text; // Return source as absolute final fallback
    }
  }
}
