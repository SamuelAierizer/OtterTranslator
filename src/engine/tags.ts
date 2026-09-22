/**
 * Tag-scheme helpers ([f1]...[/f1] bracket tags used to carry formatting through translation).
 */

export function validateTags(source: string, translated: string): boolean {
  const extractTags = (text: string) => {
    const fTags: string[] = [];
    const hTags: string[] = [];
    const oTags: string[] = [];
    const brTags: number = (text.match(/\[br\/\]/g) || []).length;

    const fRegex = /\[f(\d+)\]/g;
    let match: RegExpExecArray | null;
    while ((match = fRegex.exec(text)) !== null) {
      fTags.push(match[1]);
    }

    const hRegex = /\[h(\d+)\]/g;
    while ((match = hRegex.exec(text)) !== null) {
      hTags.push(match[1]);
    }

    const oRegex = /\[o(\d+)\/\]/g;
    while ((match = oRegex.exec(text)) !== null) {
      oTags.push(match[1]);
    }

    const fOpenCount = (text.match(/\[f\d+\]/g) || []).length;
    const fCloseCount = (text.match(/\[\/f\d+\]/g) || []).length;

    const hOpenCount = (text.match(/\[h\d+\]/g) || []).length;
    const hCloseCount = (text.match(/\[\/h\d+\]/g) || []).length;

    return {
      fTags,
      hTags,
      oTags,
      brTags,
      fOpenCount,
      fCloseCount,
      hOpenCount,
      hCloseCount,
      fBalanced: fOpenCount === fCloseCount,
      hBalanced: hOpenCount === hCloseCount
    };
  };

  const sourceTags = extractTags(source);
  const translatedTags = extractTags(translated);

  if (!sourceTags.fBalanced || !translatedTags.fBalanced) return false;
  if (!sourceTags.hBalanced || !translatedTags.hBalanced) return false;

  sourceTags.fTags.sort();
  translatedTags.fTags.sort();
  if (sourceTags.fTags.length !== translatedTags.fTags.length ||
      !sourceTags.fTags.every((v, i) => v === translatedTags.fTags[i])) {
    return false;
  }

  sourceTags.hTags.sort();
  translatedTags.hTags.sort();
  if (sourceTags.hTags.length !== translatedTags.hTags.length ||
      !sourceTags.hTags.every((v, i) => v === translatedTags.hTags[i])) {
    return false;
  }

  sourceTags.oTags.sort();
  translatedTags.oTags.sort();
  if (sourceTags.oTags.length !== translatedTags.oTags.length ||
      !sourceTags.oTags.every((v, i) => v === translatedTags.oTags[i])) {
    return false;
  }

  return sourceTags.brTags === translatedTags.brTags;
}

export function cleanTranslatedBrackets(text: string): string {
  return text
    .replace(/\[\s*(f\d+)\s*\]/g, '[$1]')
    .replace(/\[\s*\/\s*(f\d+)\s*\]/g, '[/$1]')
    .replace(/\[\s*(h\d+)\s*\]/g, '[$1]')
    .replace(/\[\s*\/\s*(h\d+)\s*\]/g, '[/$1]')
    .replace(/\[\s*(o\d+)\s*\/\s*\]/g, '[$1/]')
    .replace(/\[\s*br\s*\/?\s*\]/g, '[br/]');
}

export function stripTags(text: string): string {
  return text.replace(/\[\/?[^\]]+\]/g, '');
}
