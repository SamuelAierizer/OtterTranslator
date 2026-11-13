import type { Document } from '@xmldom/xmldom';
import { BREAKS_KEY } from './xml-parser.js';
import type { BreakInfo } from './xml-parser.js';

const W_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export interface Token {
  type: 'text' | 'run-open' | 'run-close' | 'br' | 'container-open' | 'container-close' | 'placeholder';
  content?: string;
  styleId?: string;
  containerId?: string;
}

const TAG_REGEX = /\[(f\d+)\]|\[\/(f\d+)\]|\[(h\d+)\]|\[\/(h\d+)\]|\[(o\d+)\/\]|\[br\/\]/g;

/**
 * Tokenize translated tagged text into a flat, in-order token stream.
 *
 * Every tag is a token of its own, so tags nested inside others (a [br/] inside [f1]...[/f1], a
 * formatted run inside a hyperlink) are recognised instead of being swallowed as literal text.
 */
export function parseTranslatedText(translatedText: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let match: RegExpExecArray | null;
  TAG_REGEX.lastIndex = 0;

  while ((match = TAG_REGEX.exec(translatedText)) !== null) {
    if (match.index > index) {
      tokens.push({ type: 'text', content: translatedText.substring(index, match.index) });
    }

    if (match[1]) tokens.push({ type: 'run-open', styleId: match[1] });
    else if (match[2]) tokens.push({ type: 'run-close', styleId: match[2] });
    else if (match[3]) tokens.push({ type: 'container-open', containerId: match[3] });
    else if (match[4]) tokens.push({ type: 'container-close', containerId: match[4] });
    else if (match[5]) tokens.push({ type: 'placeholder', styleId: match[5] });
    else tokens.push({ type: 'br' });

    index = TAG_REGEX.lastIndex;
  }

  if (index < translatedText.length) {
    tokens.push({ type: 'text', content: translatedText.substring(index) });
  }

  return tokens;
}

/**
 * Create an empty w:r, with a copy of the given run formatting if any.
 */
function createRun(dom: Document, rPrNode: any): any {
  const rNode = dom.createElementNS(W_NAMESPACE, 'w:r');
  if (rPrNode) {
    rNode.appendChild(rPrNode.cloneNode(true));
  }
  return rNode;
}

/**
 * Append text to a run, turning tab characters into <w:tab/> elements.
 */
function appendText(dom: Document, rNode: any, textContent: string): void {
  const segments = textContent.split('\t');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== '') {
      const tNode = dom.createElementNS(W_NAMESPACE, 'w:t');
      tNode.setAttribute('xml:space', 'preserve');
      tNode.textContent = segments[i];
      rNode.appendChild(tNode);
    }
    if (i < segments.length - 1) {
      rNode.appendChild(dom.createElementNS(W_NAMESPACE, 'w:tab'));
    }
  }
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
  const breaks: BreakInfo[] = styleMap.get(BREAKS_KEY) ?? [];
  let breakIndex = 0;

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

  // Open containers; the innermost is where new runs go.
  const elementStack: Array<{ node: any; containerId: string | null }> = [{ node: wpNode, containerId: null }];
  // The [fN] whose text is currently being written, if any.
  let activeStyleId: string | null = null;
  // The run content is currently appended to, and the formatting it was opened with. Consecutive
  // text, breaks and tabs with the same formatting share one run, in the order they appear.
  let currentRun: any = null;
  let currentRunKey: string | null = null;

  const parentNode = () => elementStack[elementStack.length - 1].node;
  const closeRun = () => {
    currentRun = null;
    currentRunKey = null;
  };
  const runFor = (key: string, rPr: any): any => {
    if (currentRun && currentRunKey === key) return currentRun;
    currentRun = createRun(dom, rPr);
    currentRunKey = key;
    parentNode().appendChild(currentRun);
    return currentRun;
  };

  for (const token of tokens) {
    if (token.type === 'text') {
      const key = activeStyleId ?? '';
      const rPr = activeStyleId ? styleMap.get(activeStyleId) : null;
      appendText(dom, runFor(key, rPr), token.content || '');
    } else if (token.type === 'run-open') {
      activeStyleId = token.styleId || null;
      closeRun();
    } else if (token.type === 'run-close') {
      if (activeStyleId === token.styleId) activeStyleId = null;
      closeRun();
    } else if (token.type === 'br') {
      const info: BreakInfo | undefined = breaks[breakIndex++];
      const brNode = info ? info.node.cloneNode(true) : dom.createElementNS(W_NAMESPACE, 'w:br');
      if (activeStyleId) {
        // Inside [fN]...[/fN]: the break belongs to that formatted run.
        runFor(activeStyleId, styleMap.get(activeStyleId)).appendChild(brNode);
      } else if (info?.rPr) {
        // A break that sat alone in its own formatted run gets that run back.
        closeRun();
        runFor(`break:${breakIndex}`, info.rPr).appendChild(brNode);
        closeRun();
      } else {
        runFor('', null).appendChild(brNode);
      }
    } else if (token.type === 'container-open') {
      closeRun();
      const containerId = token.containerId || '';
      const containerMeta = styleMap.get(containerId);
      const containerNode = containerMeta ? createContainerNode(dom, containerMeta.nodeName) : null;
      if (containerNode) {
        if (containerMeta.attributes) {
          for (const [attrName, attrValue] of Object.entries(containerMeta.attributes)) {
            (containerNode as any).setAttribute(attrName, attrValue as string);
          }
        }
        parentNode().appendChild(containerNode);
        if (containerMeta.nodeName === 'w:sdt') {
          for (const property of containerMeta.properties ?? []) containerNode.appendChild(property.cloneNode(true));
          const content = containerMeta.contentTemplate?.cloneNode(false) ?? dom.createElementNS(W_NAMESPACE, 'w:sdtContent');
          containerNode.appendChild(content);
          elementStack.push({ node: content, containerId });
        } else elementStack.push({ node: containerNode, containerId });
      }
    } else if (token.type === 'container-close') {
      closeRun();
      const depth = elementStack.findIndex((entry) => entry.containerId === token.containerId);
      if (depth > 0) elementStack.length = depth;
    } else if (token.type === 'placeholder') {
      const placeholderId = token.styleId || '';
      const preservedMeta = styleMap.get(placeholderId);
      if (preservedMeta?.literal) {
        appendText(dom, runFor(activeStyleId ?? '', activeStyleId ? styleMap.get(activeStyleId) : null), preservedMeta.literal);
      } else if (preservedMeta && preservedMeta.nodeName === 'preserved-run') {
        closeRun();
        const preservedRun = (preservedMeta.originalNode as any).cloneNode(true);
        if (preservedMeta.wrapper) {
          const wrapper = preservedMeta.wrapper.cloneNode(true);
          wrapper.appendChild(preservedRun);
          parentNode().appendChild(wrapper);
        } else parentNode().appendChild(preservedRun);
      }
    }
  }
}
