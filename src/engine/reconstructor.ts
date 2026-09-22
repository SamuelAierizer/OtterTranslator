import { unescapeXml } from './xml-parser.js';

const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

interface Token {
  type: 'text' | 'run' | 'br' | 'container-open' | 'container-close' | 'placeholder';
  content?: string;
  styleId?: string;
  containerId?: string;
}

/**
 * Tokenize translated tagged text back into structures we can use to rebuild DOCX runs.
 */
export function parseTranslatedText(translatedText: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const tagRegex = /\[(f\d+)\]([\s\S]*?)\[\/\1\]|\[(h\d+)\]([\s\S]*?)\[\/\3\]|\[(o\d+)\/\]|(\[br\/\])/g;

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(translatedText)) !== null) {
    if (match.index > index) {
      const textVal = translatedText.substring(index, match.index);
      tokens.push({ type: 'text', content: unescapeXml(textVal) });
    }

    if (match[8]) {
      tokens.push({ type: 'br' });
    } else if (match[3]) {
      const containerId = match[3];
      tokens.push({ type: 'container-open', containerId });
      const innerContent = match[4];
      if (innerContent.trim()) {
        tokens.push({ type: 'text', content: unescapeXml(innerContent) });
      }
      tokens.push({ type: 'container-close', containerId });
    } else if (match[5]) {
      tokens.push({ type: 'placeholder', styleId: match[5] });
    } else {
      const styleId = match[1];
      const content = match[2];
      tokens.push({ type: 'run', styleId, content: unescapeXml(content) });
    }

    index = tagRegex.lastIndex;
  }

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
 * Create a container node (hyperlink, ins, smartTag, sdt, fldSimple)
 */
function createContainerNode(dom: Document, nodeName: string): any {
  if (nodeName === 'w:hyperlink') {
    return dom.createElementNS(W_NAMESPACE, 'w:hyperlink');
  } else if (nodeName === 'w:ins') {
    return dom.createElementNS(W_NAMESPACE, 'w:ins');
  } else if (nodeName === 'w:smartTag') {
    return dom.createElementNS(W_NAMESPACE, 'w:smartTag');
  } else if (nodeName === 'w:sdt') {
    return dom.createElementNS(W_NAMESPACE, 'w:sdt');
  } else if (nodeName === 'w:fldSimple') {
    return dom.createElementNS(W_NAMESPACE, 'w:fldSimple');
  }
  return null;
}

export function reconstructParagraph(
  dom: Document,
  wpNode: any,
  translatedText: string,
  styleMap: Map<string, any>
): void {
  const tokens = parseTranslatedText(translatedText);

  let pPrNode: any = null;
  const childNodes = Array.from(wpNode.childNodes);
  for (const child of childNodes) {
    if ((child as any).nodeName === 'w:pPr') {
      pPrNode = child;
    }
  }

  while (wpNode.firstChild) {
    wpNode.removeChild(wpNode.firstChild);
  }

  if (pPrNode) {
    wpNode.appendChild(pPrNode);
  }

  const elementStack: any[] = [wpNode];

  for (const token of tokens) {
    const currentParent = elementStack[elementStack.length - 1];

    if (token.type === 'text') {
      const rNode = createRunNode(dom, token.content || '', null);
      currentParent.appendChild(rNode);
    } else if (token.type === 'run') {
      const originalRPr = styleMap.get(token.styleId || '');
      const rNode = createRunNode(dom, token.content || '', originalRPr);
      currentParent.appendChild(rNode);
    } else if (token.type === 'br') {
      const brNode = createBreakRunNode(dom);
      currentParent.appendChild(brNode);
    } else if (token.type === 'container-open') {
      const containerId = token.containerId || '';
      const containerMeta = styleMap.get(containerId);
      if (containerMeta) {
        const containerNode = createContainerNode(dom, containerMeta.nodeName);
        if (containerMeta.attributes) {
          for (const [attrName, attrValue] of Object.entries(containerMeta.attributes)) {
            (containerNode as any).setAttribute(attrName, attrValue as string);
          }
        }
        currentParent.appendChild(containerNode);
        elementStack.push(containerNode);
      }
    } else if (token.type === 'container-close') {
      if (elementStack.length > 1) {
        elementStack.pop();
      }
    } else if (token.type === 'placeholder') {
      const placeholderId = token.styleId || '';
      const preservedMeta = styleMap.get(placeholderId);
      if (preservedMeta && preservedMeta.nodeName === 'preserved-run') {
        const preservedRun = (preservedMeta.originalNode as any).cloneNode(true);
        currentParent.appendChild(preservedRun);
      }
    }
  }
}
