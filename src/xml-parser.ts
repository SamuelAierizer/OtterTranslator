import { DOMParser } from '@xmldom/xmldom';
import { TranslationBlock } from './types.js';

/**
 * Compare two run properties (w:rPr) to see if they are identical in formatting.
 */
function areRunPropertiesEqual(rPr1: any, rPr2: any): boolean {
  if (!rPr1 && !rPr2) return true;
  if (!rPr1 || !rPr2) return false;
  
  // Quick optimization: compare serialized strings of rPr
  const s1 = rPr1.toString().trim();
  const s2 = rPr2.toString().trim();
  return s1 === s2;
}

/**
 * Merge adjacent runs in a paragraph that have identical formatting.
 * This resolves the "split runs" issue common in DOCX.
 */
export function normalizeParagraph(wpNode: any): void {
  const childNodes = Array.from(wpNode.childNodes);
  const runs = childNodes.filter((node: any) => node.nodeName === 'w:r');
  
  if (runs.length <= 1) return;

  let currentRun: any = runs[0];
  
  for (let i = 1; i < runs.length; i++) {
    const nextRun: any = runs[i];
    
    const rPr1 = Array.from(currentRun.childNodes).find((n: any) => n.nodeName === 'w:rPr');
    const rPr2 = Array.from(nextRun.childNodes).find((n: any) => n.nodeName === 'w:rPr');
    
    // Check if both runs only contain text nodes (w:t), and no complex objects (like w:drawing)
    const hasOnlyTextOrBreaks1 = Array.from(currentRun.childNodes).every((n: any) => 
      n.nodeName === 'w:rPr' || n.nodeName === 'w:t' || n.nodeName === 'w:br' || n.nodeName === 'w:tab'
    );
    const hasOnlyTextOrBreaks2 = Array.from(nextRun.childNodes).every((n: any) => 
      n.nodeName === 'w:rPr' || n.nodeName === 'w:t' || n.nodeName === 'w:br' || n.nodeName === 'w:tab'
    );

    if (hasOnlyTextOrBreaks1 && hasOnlyTextOrBreaks2 && areRunPropertiesEqual(rPr1, rPr2)) {
      // Merge content of nextRun into currentRun
      const nextChildren = Array.from(nextRun.childNodes);
      for (const child of nextChildren) {
        if ((child as any).nodeName === 'w:t') {
          // Find or create w:t in currentRun
          const currentT = Array.from(currentRun.childNodes).find((n: any) => n.nodeName === 'w:t');
          if (currentT) {
            (currentT as any).textContent += (child as any).textContent;
          } else {
            currentRun.appendChild((child as any).cloneNode(true));
          }
        } else if ((child as any).nodeName === 'w:br' || (child as any).nodeName === 'w:tab') {
          currentRun.appendChild((child as any).cloneNode(true));
        }
      }
      // Remove nextRun from paragraph DOM
      wpNode.removeChild(nextRun);
    } else {
      currentRun = nextRun;
    }
  }
}

/**
 * Serialize a paragraph node (w:p) into a tagged string and a style metadata map.
 */
export function serializeParagraph(wpNode: any): { text: string; styleMap: Map<string, any> } {
  // First normalize adjacent runs
  normalizeParagraph(wpNode);

  const childNodes = Array.from(wpNode.childNodes);
  const styleMap = new Map<string, any>();
  let taggedText = '';
  let formatCounter = 1;

  for (const child of childNodes) {
    if ((child as any).nodeName === 'w:r') {
      const rPr = Array.from((child as any).childNodes).find((n: any) => n.nodeName === 'w:rPr');
      
      // Collect all text, br, tab content in this run
      let runContent = '';
      const runChildren = Array.from((child as any).childNodes);
      
      const hasText = runChildren.some((n: any) => n.nodeName === 'w:t' && n.textContent.trim().length > 0);
      
      if (!hasText) {
        // If run has no text content (e.g. only shapes, equations, breaks), preserve its XML as is
        // We will output it as a special self-closing tag or placeholder so LLM doesn't touch it
        // Or we can just leave it unchanged and place it in the same spot during reconstruction.
        // For simplicity, if it has other nodes like drawings, we skip translating them.
        continue;
      }

      for (const runChild of runChildren) {
        if ((runChild as any).nodeName === 'w:t') {
          runContent += (runChild as any).textContent;
        } else if ((runChild as any).nodeName === 'w:br') {
          runContent += '[br/]';
        } else if ((runChild as any).nodeName === 'w:tab') {
          runContent += '\t';
        }
      }

      // If the run has formatting (w:rPr contains nodes other than just language properties)
      const hasSignificantFormatting = rPr && Array.from((rPr as any).childNodes).some((n: any) => n.nodeName !== 'w:lang');

      if (hasSignificantFormatting) {
        const styleId = `f${formatCounter++}`;
        styleMap.set(styleId, (rPr as any).cloneNode(true)); // Clone w:rPr for reconstruction
        taggedText += `[${styleId}]${escapeXml(runContent)}[/${styleId}]`;
      } else {
        taggedText += escapeXml(runContent);
      }
    }
  }

  return {
    text: taggedText,
    styleMap
  };
}

/**
 * Escapes XML special characters in raw strings.
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, function (c: string) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Unescapes XML/HTML entities back to raw text.
 */
export function unescapeXml(safe: string): string {
  return safe.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&apos;/g, "'");
}

/**
 * Extract all blocks (paragraphs with text) from a DOM object
 */
export function extractBlocksFromDOM(dom: Document, partName: string): TranslationBlock[] {
  const blocks: TranslationBlock[] = [];
  const paragraphs = dom.getElementsByTagName('w:p');

  for (let i = 0; i < paragraphs.length; i++) {
    const wpNode = paragraphs[i];
    const { text, styleMap } = serializeParagraph(wpNode);

    // Only process paragraphs that contain some translatable text
    if (text.trim().length > 0) {
      blocks.push({
        id: `${partName}_p_${i}`,
        partName,
        text,
        styleMap,
        wpNode // Keep reference to original node to update later
      });
    }
  }

  return blocks;
}
