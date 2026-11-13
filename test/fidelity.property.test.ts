/**
 * Property-based round-trip tests: instead of hand-picked examples, a seeded generator builds
 * random paragraphs from the constructs Word emits (formatted runs, text, line/page/column breaks,
 * carriage returns, tabs, hyperlinks, escaped characters) and checks properties that must hold for
 * every one of them. Seeds are fixed, so every run checks the same cases; a failure names its seed,
 * and `paragraphXml(seed)` reproduces the input.
 *
 * Runs with tab-only or whitespace-only content are not generated: dropping those is known
 * (findings.md F-08), not a property violation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { extractBlocksFromDOM } from '../src/engine/xml-parser.ts';
import { reconstructParagraph } from '../src/engine/reconstructor.ts';
import { isWellFormed, validateTags } from '../src/engine/tags.ts';

const SEEDS = 1500;
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** mulberry32: tiny deterministic PRNG. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

const FORMATS = ['', '<w:rPr><w:b/></w:rPr>', '<w:rPr><w:i/></w:rPr>', '<w:rPr><w:b/><w:i/></w:rPr>',
  '<w:rPr><w:sz w:val="8"/></w:rPr>', '<w:rPr><w:lang w:val="en-US"/></w:rPr>'];
const WORDS = ['alpha', 'beta', 'A &amp; B', '&lt;x&gt;', 'árvíztűrő', 'x', 'Hello world', '[[a]]', '2+2=4', 'don&apos;t'];
const BREAKS = ['<w:br/>', '<w:br w:type="page"/>', '<w:br w:type="column"/>', '<w:cr/>'];

function runXml(r: ReturnType<typeof random>): string {
  const format = r.pick(FORMATS);
  if (r.next() < 0.15) return `<w:r>${format}${r.pick(BREAKS)}</w:r>`;
  const parts: string[] = [];
  let hasWord = false;
  for (let i = 0, n = 1 + r.int(5); i < n; i++) {
    const k = r.next();
    if (k < 0.55) {
      parts.push(`<w:t xml:space="preserve">${r.next() < 0.2 ? ' ' : ''}${r.pick(WORDS)}${r.next() < 0.2 ? ' ' : ''}</w:t>`);
      hasWord = true;
    } else if (k < 0.8) parts.push(r.pick(BREAKS));
    else parts.push('<w:tab/>');
  }
  if (!hasWord) parts.push(`<w:t>${r.pick(WORDS)}</w:t>`);
  return `<w:r>${format}${parts.join('')}</w:r>`;
}

export function paragraphXml(seed: number): string {
  const r = random(seed);
  const items: string[] = [];
  for (let i = 0, n = 1 + r.int(7); i < n; i++) {
    if (r.next() < 0.15) {
      const inner = Array.from({ length: 1 + r.int(3) }, () => runXml(r)).join('');
      items.push(`<w:hyperlink w:anchor="a${i}">${inner}</w:hyperlink>`);
    } else items.push(runXml(r));
  }
  return `<w:p>${items.join('')}</w:p>`;
}

function parse(paragraph: string): { dom: any; p: any } {
  const dom = new DOMParser().parseFromString(`<w:document xmlns:w="${W_NS}"><w:body>${paragraph}</w:body></w:document>`, 'application/xml');
  return { dom, p: dom.getElementsByTagName('w:p')[0] };
}

/**
 * What a reader sees: one entry per character, break and tab, with its effective formatting
 * (ignoring w:lang, which the engine deliberately drops) and enclosing hyperlink.
 */
function fingerprint(p: any): string[] {
  const out: string[] = [];
  const walk = (node: any, link: string) => {
    for (const child of Array.from(node.childNodes) as any[]) {
      if (child.nodeName === 'w:hyperlink') walk(child, child.getAttribute('w:anchor') || 'link');
      else if (child.nodeName === 'w:r') {
        const rPr = (Array.from(child.childNodes) as any[]).find((n) => n.nodeName === 'w:rPr');
        const format = rPr
          ? (Array.from(rPr.childNodes) as any[]).filter((n) => n.nodeType === 1 && n.nodeName !== 'w:lang')
              .map((n) => n.nodeName + (n.getAttribute('w:val') ?? '')).join('+')
          : '';
        for (const item of Array.from(child.childNodes) as any[]) {
          if (item.nodeName === 'w:t') for (const ch of item.textContent) out.push(`${ch}|${format}|${link}`);
          else if (item.nodeName === 'w:br') out.push(`BR:${item.getAttribute('w:type') || 'line'}|${link}`);
          else if (item.nodeName === 'w:cr') out.push(`CR|${link}`);
          else if (item.nodeName === 'w:tab') out.push(`TAB|${format}|${link}`);
        }
      }
    }
  };
  walk(p, '');
  return out;
}

/** A perfect translator: upper-cases text, leaves the engine's tags and XML entities untouched. */
const translate = (text: string) =>
  text.split(/(\[(?:\/?[fh]\d+|o\d+\/|br\/)\]|&[a-z]+;)/).map((part, i) => (i % 2 ? part : part.toUpperCase())).join('');

const TAG = /\[(?:\/?[fh]\d+|o\d+\/|br\/)\]/g;
const LEAKED_TAG = /\[(?:\/?[fh]\d+|o\d+\/|br\/)\]/;

/** Runs `check` for every seed and reports all failing seeds at once. */
function forAllSeeds(check: (seed: number) => string | null, options: { textOnly?: boolean } = { textOnly: true }): void {
  const failures: string[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    if (options.textOnly && !hasText(seed)) continue;
    const problem = check(seed);
    if (problem) failures.push(`seed ${seed}: ${problem}`);
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} of ${SEEDS} seeds failed`);
}

/** Paragraphs made only of break runs have nothing to translate and are not extracted (F-04). */
const hasText = (seed: number) => fingerprint(parse(paragraphXml(seed)).p).some((entry) => entry.split('|')[0].length === 1);

test('a paragraph is extracted exactly when it has text; its tags are well-formed and self-valid', () => {
  forAllSeeds((seed) => {
    const { dom } = parse(paragraphXml(seed));
    const [block] = extractBlocksFromDOM(dom, 'd');
    if (!hasText(seed)) return block ? `break-only paragraph was extracted: ${block.text}` : null;
    if (!block) return 'paragraph with text was not extracted';
    if (!isWellFormed(block.text)) return `serializer produced ill-formed tags: ${block.text}`;
    if (!validateTags(block.text, block.text)) return `validator rejects the untouched source: ${block.text}`;
    return null;
  }, { textOnly: false });
});

test('an untranslated round trip reproduces every character, break, tab, format and link', () => {
  forAllSeeds((seed) => {
    const xml = paragraphXml(seed);
    const expected = fingerprint(parse(xml).p);
    const { dom, p } = parse(xml);
    const [block] = extractBlocksFromDOM(dom, 'd');
    reconstructParagraph(dom, p, block.text, block.styleMap);
    return JSON.stringify(fingerprint(p)) === JSON.stringify(expected) ? null : `changed: ${block.text}`;
  });
});

test('extraction is idempotent: a rebuilt paragraph serializes to the same tagged text', () => {
  forAllSeeds((seed) => {
    const { dom, p } = parse(paragraphXml(seed));
    const [block] = extractBlocksFromDOM(dom, 'd');
    reconstructParagraph(dom, p, block.text, block.styleMap);
    const [again] = extractBlocksFromDOM(dom, 'd');
    return again.text === block.text ? null : `${block.text} -> ${again.text}`;
  });
});

test('a tag-preserving translation keeps structure and formatting, with no tags leaking into text', () => {
  forAllSeeds((seed) => {
    const xml = paragraphXml(seed);
    const expected = fingerprint(parse(xml).p).map((entry) => {
      const [ch, ...rest] = entry.split('|');
      return ch.length === 1 ? [ch.toUpperCase(), ...rest].join('|') : entry;
    });
    const { dom, p } = parse(xml);
    const [block] = extractBlocksFromDOM(dom, 'd');
    const translated = translate(block.text);
    if (!validateTags(block.text, translated)) return `perfect translation rejected: ${block.text}`;
    reconstructParagraph(dom, p, translated, block.styleMap);
    if (JSON.stringify(fingerprint(p)) !== JSON.stringify(expected)) return `structure changed: ${block.text}`;
    const written = (Array.from(p.getElementsByTagName('w:t')) as any[]).map((t) => t.textContent).join('');
    return LEAKED_TAG.test(written) ? `tag leaked into text: ${written}` : null;
  });
});

// F-17 at scale: move one tag to a random position (the tag counts stay correct, which is what
// fooled the old count-only validator). Whatever the validator accepts must rebuild safely.
test('any tag arrangement the validator accepts is well-formed and rebuilds without losing content', () => {
  forAllSeeds((seed) => {
    const { dom } = parse(paragraphXml(seed));
    const [block] = extractBlocksFromDOM(dom, 'd');
    const r = random(seed * 7919);
    for (let k = 0; k < 10; k++) {
      const tags = [...block.text.matchAll(TAG)];
      if (tags.length === 0) return null;
      const moved = tags[r.int(tags.length)];
      const without = block.text.slice(0, moved.index) + block.text.slice(moved.index! + moved[0].length);
      const at = r.int(without.length + 1);
      const mutant = without.slice(0, at) + moved[0] + without.slice(at);
      if (!validateTags(block.text, mutant)) continue;
      if (!isWellFormed(mutant)) return `accepted ill-formed reply: ${mutant}`;

      const target = parse(paragraphXml(seed));
      const [fresh] = extractBlocksFromDOM(target.dom, 'd');
      reconstructParagraph(target.dom, target.p, mutant, fresh.styleMap);
      const written = (Array.from(target.p.getElementsByTagName('w:t')) as any[]).map((t) => t.textContent).join('');
      if (LEAKED_TAG.test(written)) return `tag leaked into text: ${mutant}`;
      const breaks = target.p.getElementsByTagName('w:br').length + target.p.getElementsByTagName('w:cr').length;
      const expectedBreaks = (block.text.match(/\[br\/\]/g) || []).length;
      if (breaks !== expectedBreaks) return `break count ${breaks} != ${expectedBreaks}: ${mutant}`;
      const xml = new XMLSerializer().serializeToString(target.p);
      if ((xml.match(/<w:hyperlink/g) || []).length !== (block.text.match(/\[h\d+\]/g) || []).length) {
        return `hyperlink lost: ${mutant}`;
      }
    }
    return null;
  });
});
