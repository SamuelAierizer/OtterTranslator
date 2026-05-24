import { unescapeXml } from './xml-parser.js';

const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

interface Token {
  type: 'text' | 'run' | 'br';
  content?: string;
  styleId?: string;
}

/**
 * Tokenize translated tagged text back into structures we can use to rebuild DOCX runs.
 */
export function parseTranslatedText(translatedText: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  
  // Regex to match either a [fX]...[/fX] tag or a [br/] tag
  const tagRegex = /\[(f\d+)\]([\s\S]*?)\[\/\1\]|(\[br\/\])/g;
  
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(translatedText)) !== null) {
    // Add text preceding the match
    if (match.index > index) {
      const textVal = translatedText.substring(index, match.index);
      tokens.push({ type: 'text', content: unescapeXml(textVal) });
    }
    
    if (match[3]) {
      // It's a [br/] line break
      tokens.push({ type: 'br' });
    } else {
      // It's a [fX]...[/fX]
      const styleId = match[1];
      const content = match[2];
      tokens.push({ type: 'run', styleId, content: unescapeXml(content) });
    }
    
    index = tagRegex.lastIndex;
  }
  
  // Add trailing text
  if (index < translatedText.length) {
    const textVal = translatedText.substring(index);
    tokens.push({ type: 'text', content: unescapeXml(textVal) });
  }
  
  return tokens;
}

/**
 * Create a new styled w:r (run) node inside the DOM
 */
function createRunNode(dom: Document, textContent: string, rPrNode: any): any {
  const rNode = dom.createElementNS(W_NAMESPACE, 'w:r');
  
  // Apply original run formatting if it exists
  if (rPrNode) {
    rNode.appendChild(rPrNode.cloneNode(true));
  }
  
  // Handle tab characters by splitting text and inserting <w:tab/> elements
  const segments = textContent.split('\t');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== '') {
      const tNode = dom.createElementNS(W_NAMESPACE, 'w:t');
      tNode.setAttribute('xml:space', 'preserve');
      tNode.textContent = segments[i];
      rNode.appendChild(tNode);
    }
    if (i < segments.length - 1) {
      const tabNode = dom.createElementNS(W_NAMESPACE, 'w:tab');
      rNode.appendChild(tabNode);
    }
  }
  
  return rNode;
}

/**
 * Create a run node containing a line break (<w:br/>)
 */
function createBreakRunNode(dom: Document): any {
  const rNode = dom.createElementNS(W_NAMESPACE, 'w:r');
  const brNode = dom.createElementNS(W_NAMESPACE, 'w:br');
  rNode.appendChild(brNode);
  return rNode;
}

/**
 * Reconstruct a paragraph's runs using the translated text and original style map
 */
export function reconstructParagraph(
  dom: Document,
  wpNode: any,
  translatedText: string,
  styleMap: Map<string, any>
): void {
  const tokens = parseTranslatedText(translatedText);
  
  // Extract paragraph properties (w:pPr) and non-translatable runs (e.g., runs containing drawings)
  let pPrNode: any = null;
  const preservedNodes: any[] = [];

  const childNodes = Array.from(wpNode.childNodes);
  for (const child of childNodes) {
    if ((child as any).nodeName === 'w:pPr') {
      pPrNode = child;
    } else if ((child as any).nodeName === 'w:r') {
      const hasDrawing = (child as any).getElementsByTagNameNS ? 
        ((child as any).getElementsByTagNameNS(W_NAMESPACE, 'drawing').length > 0 || (child as any).getElementsByTagNameNS(W_NAMESPACE, 'object').length > 0) :
        ((child as any).getElementsByTagName('w:drawing').length > 0 || (child as any).getElementsByTagName('w:object').length > 0);
      
      const hasText = (child as any).getElementsByTagNameNS ?
        (child as any).getElementsByTagNameNS(W_NAMESPACE, 't').length > 0 :
        (child as any).getElementsByTagName('w:t').length > 0;

      if (hasDrawing || !hasText) {
        preservedNodes.push(child);
      }
    } else {
      // Keep other structural children like w:bookmarkStart, w:proofErr etc.
      preservedNodes.push(child);
    }
  }

  // Clear all children of the paragraph node
  while (wpNode.firstChild) {
    wpNode.removeChild(wpNode.firstChild);
  }

  // Re-append paragraph properties first
  if (pPrNode) {
    wpNode.appendChild(pPrNode);
  }

  // Append new translated runs
  for (const token of tokens) {
    if (token.type === 'text') {
      const rNode = createRunNode(dom, token.content || '', null);
      wpNode.appendChild(rNode);
    } else if (token.type === 'run') {
      const originalRPr = styleMap.get(token.styleId || '');
      const rNode = createRunNode(dom, token.content || '', originalRPr);
      wpNode.appendChild(rNode);
    } else if (token.type === 'br') {
      const brNode = createBreakRunNode(dom);
      wpNode.appendChild(brNode);
    }
  }

  // Append any preserved drawing or non-text nodes at the end to ensure they remain in the layout
  for (const node of preservedNodes) {
    wpNode.appendChild(node);
  }
}
