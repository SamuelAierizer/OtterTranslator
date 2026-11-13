import type { Document } from '@xmldom/xmldom';
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

/** Run children that `normalizeParagraph` knows how to carry across when merging two runs. */
const MERGEABLE_RUN_CHILDREN = new Set(['w:rPr', 'w:t', 'w:br', 'w:cr', 'w:tab']);

/** Line-break elements. Both are carried through translation as `[br/]`. */
function isBreak(node: any): boolean {
  return node.nodeName === 'w:br' || node.nodeName === 'w:cr';
}

/**
 * Key in a block's styleMap holding the original break elements, in `[br/]` order. The tag itself
 * carries no id, so the N-th `[br/]` in a translation is rebuilt from the N-th original break; that
 * keeps page/column breaks (`w:type`) and `w:cr` from collapsing into plain line breaks.
 */
export const BREAKS_KEY = '__breaks';

export interface BreakInfo {
  /** Clone of the original `w:br` / `w:cr` element. */
  node: any;
  /**
   * Formatting of the run the break came from, when that formatting is not already carried by an
   * enclosing `[fN]` tag (i.e. a break alone in its own formatted run). Null otherwise.
   */
  rPr: any | null;
}

/**
 * Merge adjacent runs in a paragraph that have identical formatting.
 * This resolves the "split runs" issue common in DOCX.
 *
 * The merge must keep the reading order of the absorbed run's content: its text, breaks and tabs
 * are appended after everything already in the current run. Text is only folded into an existing
 * `w:t` when that `w:t` is the current run's last child; otherwise text would jump ahead of a
 * break, e.g. "Line one<br/>" + "Line two" must not become "Line oneLine two<br/>".
 */
export function normalizeParagraph(wpNode: any): void {
  const childNodes = Array.from(wpNode.childNodes);

  let i = 0;
  while (i < childNodes.length - 1) {
    const curr = childNodes[i] as any;
    const next = childNodes[i + 1] as any;

    if (curr.nodeName !== 'w:r' || next.nodeName !== 'w:r') {
      i++;
      continue;
    }

    const currChildren = Array.from(curr.childNodes) as any[];
    const nextChildren = Array.from(next.childNodes) as any[];
    const rPr1 = currChildren.find((n) => n.nodeName === 'w:rPr');
    const rPr2 = nextChildren.find((n) => n.nodeName === 'w:rPr');

    const mergeable =
      currChildren.every((n) => MERGEABLE_RUN_CHILDREN.has(n.nodeName)) &&
      nextChildren.every((n) => MERGEABLE_RUN_CHILDREN.has(n.nodeName)) &&
      areRunPropertiesEqual(rPr1, rPr2);

    if (!mergeable) {
      i++;
      continue;
    }

    for (const child of nextChildren) {
      if (child.nodeName === 'w:rPr') continue;
      const last = curr.lastChild as any;
      if (child.nodeName === 'w:t' && last && last.nodeName === 'w:t') {
        last.textContent = last.textContent + child.textContent;
        // Joined text can gain leading/trailing spaces that Word would otherwise strip.
        last.setAttribute('xml:space', 'preserve');
      } else {
        curr.appendChild(child);
      }
    }
    wpNode.removeChild(next);
    childNodes.splice(i + 1, 1);
    // Stay on `curr`: it may also absorb the run that now follows it.
  }
}

/**
 * Serialize a paragraph node (w:p) into a tagged string and a style metadata map.
 */
export function serializeParagraph(wpNode: any): { text: string; styleMap: Map<string, any> } {
  normalizeParagraph(wpNode);

  const styleMap = new Map<string, any>();
  const breaks: BreakInfo[] = [];
  const counters = { format: 1, container: 1, object: 1 };

  function preserve(node: any): string {
    const id = `o${counters.object++}`;
    // Retain the live node: nested text-box paragraphs are updated before this is cloned.
    styleMap.set(id, { nodeName: 'preserved-run', originalNode: node });
    return `[${id}/]`;
  }

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
    return node.nodeType === 1 ? preserve(node) : '';
  }

  function processRun(rNode: any): string {
    const runChildren = Array.from(rNode.childNodes);
    const hasText = runChildren.some((n: any) => n.nodeName === 'w:t' && n.textContent.length > 0);
    const hasBreak = runChildren.some(isBreak);
    const hasTab = runChildren.some((n: any) => n.nodeName === 'w:tab');
    if (!hasText && !hasBreak && !hasTab) return preserve(rNode);

    const rPr = runChildren.find((n: any) => n.nodeName === 'w:rPr');
    const hasSignificantFormatting = rPr && Array.from((rPr as any).childNodes).some((n: any) => n.nodeName !== 'w:lang');
    // A break-only run is emitted untagged, so an extra [fN] pair doesn't have to survive the
    // translator just for a break; its formatting travels with the break instead.
    const wrapInFormatTag = (hasText || hasTab) && hasSignificantFormatting;
    const breakRPr = !wrapInFormatTag && hasSignificantFormatting ? rPr : null;

    let runContent = '';
    for (const runChild of runChildren) {
      if ((runChild as any).nodeName === 'w:t') {
        // Literal opening brackets travel as opaque text runs, never as tag syntax.
        const pieces = (runChild as any).textContent.split('[');
        runContent += pieces.map((piece: string, i: number) => {
          if (!i) return piece;
          const literal = rNode.cloneNode(false);
          if (rPr) literal.appendChild((rPr as any).cloneNode(true));
          const t = rNode.ownerDocument.createElementNS(rNode.namespaceURI, 'w:t');
          t.textContent = '['; literal.appendChild(t);
          const tag = preserve(literal);
          styleMap.get(tag.slice(1, -2)).literal = '[';
          return tag + piece;
        }).join('');
      } else if (isBreak(runChild)) {
        breaks.push({
          node: (runChild as any).cloneNode(true),
          rPr: breakRPr ? (breakRPr as any).cloneNode(true) : null
        });
        runContent += '[br/]';
      } else if ((runChild as any).nodeName === 'w:tab') {
        runContent += '\t';
      } else if ((runChild as any).nodeName !== 'w:rPr') {
        const fragment = rNode.cloneNode(false);
        if (rPr) fragment.appendChild((rPr as any).cloneNode(true));
        const tag = preserve(runChild);
        styleMap.get(tag.slice(1, -2)).wrapper = fragment;
        runContent += tag;
      }
    }

    if (wrapInFormatTag) {
      const styleId = `f${counters.format++}`;
      styleMap.set(styleId, (rPr as any).cloneNode(true));
      return `[${styleId}]${runContent}[/${styleId}]`;
    }
    return runContent;
  }

  function processContainer(cNode: any, containerType: string): string {
    const containerId = `h${counters.container++}`;
    const childNodes = Array.from(cNode.childNodes);

    const metadata: any = {
      nodeName: containerType,
      attributes: {}
    };

    for (const attr of Array.from(cNode.attributes) as any[]) metadata.attributes[attr.name] = attr.value;
    if (containerType === 'w:sdt') {
      metadata.properties = childNodes.filter((n: any) => n.nodeName !== 'w:sdtContent').map((n: any) => n.cloneNode(true));
      metadata.contentTemplate = (childNodes.find((n: any) => n.nodeName === 'w:sdtContent') as any)?.cloneNode(false);
    }

    styleMap.set(containerId, metadata);

    let content = '';
    for (const child of childNodes) {
      const cn = (child as any).nodeName;
      if (cn === 'w:sdtPr' || cn === 'w:sdtEndPr') {
        continue;
      } else if (cn !== 'w:sdtContent' && cn !== 'w:p') {
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

  if (breaks.length > 0) styleMap.set(BREAKS_KEY, breaks);

  return {
    text: taggedText,
    styleMap
  };
}

/**
 * Extract all blocks (paragraphs with text) from a DOM object
 */
export function extractBlocksFromDOM(dom: Document, partName: string): TranslationBlock[] {
  const blocks: TranslationBlock[] = [];
  // Snapshot the list once. getElementsByTagName returns a *live* list: after any DOM change (run
  // merging changes nearly every paragraph) reading it again re-walks the whole document, which
  // made extraction quadratic. Serializing never adds or removes paragraphs, so a snapshot sees
  // exactly the same paragraphs in the same order.
  const paragraphs = Array.from(dom.getElementsByTagName('w:p'));

  for (let i = 0; i < paragraphs.length; i++) {
    const wpNode = paragraphs[i];
    const { text, styleMap } = serializeParagraph(wpNode);

    // Only process paragraphs that contain some translatable text. Breaks and the container tags
    // around them are not text: a paragraph holding just a page break, or a link around a break,
    // is left untouched rather than sent to the provider.
    if (text.replace(/\[br\/\]|\[\/?[fh]\d+\]|\[o\d+\/\]/g, '').trim().length > 0) {
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
