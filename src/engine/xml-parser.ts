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

  for (let i = 0; i < childNodes.length - 1; i++) {
    const curr = childNodes[i];
    if ((curr as any).nodeName !== 'w:r') continue;

    const next = childNodes[i + 1];
    if ((next as any).nodeName !== 'w:r') continue;

    const rPr1 = Array.from((curr as any).childNodes).find((n: any) => n.nodeName === 'w:rPr');
    const rPr2 = Array.from((next as any).childNodes).find((n: any) => n.nodeName === 'w:rPr');

    const hasOnlyTextOrBreaks1 = Array.from((curr as any).childNodes).every((n: any) =>
      n.nodeName === 'w:rPr' || n.nodeName === 'w:t' || n.nodeName === 'w:br' || n.nodeName === 'w:tab'
    );
    const hasOnlyTextOrBreaks2 = Array.from((next as any).childNodes).every((n: any) =>
      n.nodeName === 'w:rPr' || n.nodeName === 'w:t' || n.nodeName === 'w:br' || n.nodeName === 'w:tab'
    );

    if (hasOnlyTextOrBreaks1 && hasOnlyTextOrBreaks2 && areRunPropertiesEqual(rPr1, rPr2)) {
      const nextChildren = Array.from((next as any).childNodes);
      for (const child of nextChildren) {
        if ((child as any).nodeName === 'w:t') {
          const currentT = Array.from((curr as any).childNodes).find((n: any) => n.nodeName === 'w:t');
          if (currentT) {
            (currentT as any).textContent += (child as any).textContent;
          } else {
            (curr as any).appendChild((child as any).cloneNode(true));
          }
        } else if ((child as any).nodeName === 'w:br' || (child as any).nodeName === 'w:tab') {
          (curr as any).appendChild((child as any).cloneNode(true));
        }
      }
      wpNode.removeChild(next);
      childNodes.splice(i + 1, 1);
    }
  }
}

/**
 * Serialize a paragraph node (w:p) into a tagged string and a style metadata map.
 */
export function serializeParagraph(wpNode: any): { text: string; styleMap: Map<string, any> } {
  normalizeParagraph(wpNode);

  const styleMap = new Map<string, any>();
  const counters = { format: 1, container: 1, object: 1 };

  function processElement(node: any): string {
    const nodeName = (node as any).nodeName;

    if (nodeName === 'w:r') {
      return processRun(node);
    } else if (nodeName === 'w:hyperlink' || nodeName === 'w:ins' ||
               nodeName === 'w:smartTag' || nodeName === 'w:sdt' || nodeName === 'w:fldSimple') {
      return processContainer(node, nodeName);
    } else if (nodeName === 'w:pPr') {
      return '';
    }
    return '';
  }

  function processRun(rNode: any): string {
    const runChildren = Array.from(rNode.childNodes);
    const hasText = runChildren.some((n: any) => n.nodeName === 'w:t' && n.textContent.trim().length > 0);

    if (!hasText) {
      const hasDrawing = runChildren.some((n: any) => n.nodeName === 'w:drawing');
      const hasObject = runChildren.some((n: any) => n.nodeName === 'w:object' || n.nodeName === 'w:pict');

      if (hasDrawing || hasObject) {
        const placeholderId = `o${counters.object++}`;
        styleMap.set(placeholderId, {
          nodeName: 'preserved-run',
          originalNode: (rNode as any).cloneNode(true)
        });
        return `[${placeholderId}/]`;
      }
      return '';
    }

    const rPr = runChildren.find((n: any) => n.nodeName === 'w:rPr');
    let runContent = '';

    for (const runChild of runChildren) {
      if ((runChild as any).nodeName === 'w:t') {
        runContent += (runChild as any).textContent;
      } else if ((runChild as any).nodeName === 'w:br') {
        runContent += '[br/]';
      } else if ((runChild as any).nodeName === 'w:tab') {
        runContent += '\t';
      }
    }

    const hasSignificantFormatting = rPr && Array.from((rPr as any).childNodes).some((n: any) => n.nodeName !== 'w:lang');

    if (hasSignificantFormatting) {
      const styleId = `f${counters.format++}`;
      styleMap.set(styleId, (rPr as any).cloneNode(true));
      return `[${styleId}]${escapeXml(runContent)}[/${styleId}]`;
    } else {
      return escapeXml(runContent);
    }
  }

  function processContainer(cNode: any, containerType: string): string {
    const containerId = `h${counters.container++}`;
    const childNodes = Array.from(cNode.childNodes);

    const metadata: any = {
      nodeName: containerType,
      attributes: {}
    };

    if (containerType === 'w:hyperlink') {
      const rId = (cNode as any).getAttribute('r:id');
      const anchor = (cNode as any).getAttribute('w:anchor');
      if (rId) metadata.attributes['r:id'] = rId;
      if (anchor) metadata.attributes['w:anchor'] = anchor;
    } else if (containerType === 'w:sdt') {
      const sdtPr = childNodes.find((n: any) => n.nodeName === 'w:sdtPr');
      if (sdtPr) metadata.sdtPr = (sdtPr as any).cloneNode(true);
    } else if (containerType === 'w:ins') {
      const author = (cNode as any).getAttribute('w:author');
      const date = (cNode as any).getAttribute('w:date');
      if (author) metadata.attributes['w:author'] = author;
      if (date) metadata.attributes['w:date'] = date;
    }

    styleMap.set(containerId, metadata);

    let content = '';
    for (const child of childNodes) {
      const cn = (child as any).nodeName;
      if (cn === 'w:r') {
        content += processElement(child);
      } else if (cn === 'w:sdtContent') {
        const contentChildren = Array.from((child as any).childNodes);
        for (const cc of contentChildren) {
          content += processElement(cc);
        }
      } else if (cn === 'w:p') {
        const childRunNodes = Array.from((child as any).childNodes);
        for (const rn of childRunNodes) {
          content += processElement(rn);
        }
      }
    }

    return `[${containerId}]${content}[/${containerId}]`;
  }

  const childNodes = Array.from(wpNode.childNodes);
  let taggedText = '';
  for (const child of childNodes) {
    taggedText += processElement(child);
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
