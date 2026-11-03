/**
 * Free Google Translate client using the public Web API (no credentials required).
 * Highly accurate translation, preserves bracket tags, and is extremely fast.
 */
export async function translateTextGoogle(
  text: string,
  from: string = 'en',
  to: string = 'es',
  retries: number = 3
): Promise<string> {
  if (!text || text.trim() === '') return '';

  // Preserve brackets by ensuring they are not mangled by url encoding
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;

  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!res.ok) {
        throw new Error(`Google Translate HTTP Error ${res.status}: ${res.statusText}`);
      }

      const data = await res.json() as any;
      if (!data || !data[0]) {
        throw new Error('Invalid response structure from Google Translate');
      }

      // Reconstruct full text from Google sentence segments
      const translated = data[0].map((segment: any) => segment[0]).join('');
      return cleanTranslatedBrackets(translated);
    } catch (err: any) {
      attempt++;
      if (attempt > retries) {
        console.warn(`[Warning] Google Translate failed after ${retries} attempts:`, err.message);
        throw err;
      }
      // Backoff before retry
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  return text; // Fallback to original text
}

/**
 * Google Translate sometimes adds small spaces inside brackets (e.g. "[ f1 ]" or "[ /f1 ]" or "[br /]").
 * This helper cleans them up to ensure exact bracket tag matching.
 */
function cleanTranslatedBrackets(text: string): string {
  return text
    // Clean space inside opening formatting brackets: [ f1 ] -> [f1]
    .replace(/\[\s*(f\d+)\s*\]/gi, '[$1]')
    // Clean space inside closing formatting brackets: [ / f1 ] or [ /f1 ] -> [/f1]
    .replace(/\[\s*\/\s*(f\d+)\s*\]/gi, '[/$1]')
    // Clean space inside line breaks: [ br / ] or [br/] -> [br/]
    .replace(/\[\s*br\s*\/?\s*\]/gi, '[br/]')
    // Sometimes Google Translate duplicates brackets, clean up any double brackets
    .replace(/\[\[/g, '[')
    .replace(/\]\]/g, ']');
}
