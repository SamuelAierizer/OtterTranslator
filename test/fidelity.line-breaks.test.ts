import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';
import { extractBlocksFromDOM, normalizeParagraph } from '../src/engine/xml-parser.js';
import { reconstructParagraph } from '../src/engine/reconstructor.js';
import { translateDocx } from '../src/engine/index.js';
import { validateTags } from '../src/engine/tags.js';
import type { TranslationBackend } from '../src/engine/backend.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function parseBody(paragraphsXml: string): any {
  return new DOMParser().parseFromString(
    `<w:document xmlns:w="${W_NS}"><w:body>${paragraphsXml}</w:body></w:document>`,
    'application/xml'
  );
}

/** What a reader sees, in order: text, ⏎ for a line/page break, → for a tab. */
function readingOrder(node: any): string {
  let out = '';
  for (const child of Array.from(node.childNodes) as any[]) {
    if (child.nodeName === 'w:t') out += child.textContent;
    else if (child.nodeName === 'w:br' || child.nodeName === 'w:cr') out += '⏎';
    else if (child.nodeName === 'w:tab') out += '→';
    else if (child.nodeName !== 'w:rPr' && child.nodeName !== 'w:pPr') out += readingOrder(child);
  }
  return out;
}

/** Extract -> (translate) -> reconstruct a single paragraph, returning the rebuilt w:p. */
function roundTrip(runsXml: string, translate: (text: string) => string = (t) => t): { p: any; tagged: string } {
  const dom = parseBody(`<w:p>${runsXml}</w:p>`);
  const p = dom.getElementsByTagName('w:p')[0];
  const [block] = extractBlocksFromDOM(dom, 'word/document.xml');
  const translated = translate(block.text);
  assert.ok(validateTags(block.text, translated), 'test translation must keep tags valid');
  reconstructParagraph(dom, p, translated, block.styleMap);
  return { p, tagged: block.text };
}

function buildDocx(bodyXml: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  ));
  zip.addFile('word/document.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`
  ));
  return zip.toBuffer();
}

/** Upper-cases text between tags, leaving tags untouched: a well-behaved "translation". */
const upperCaseBackend: TranslationBackend = {
  name: 'upper',
  async translateBatch(texts: string[]) {
    return texts.map((text) => text.split(/(\[[^\]]*\])/).map((part, i) => (i % 2 ? part : part.toUpperCase())).join(''));
  },
};

// Layouts Word really produces around line breaks. Each must read identically after a round trip.
const layouts: Record<string, string> = {
  'break at the end of a run, same-format neighbour':
    '<w:r><w:t>Line one</w:t><w:br/></w:r><w:r><w:t>Line two</w:t></w:r>',
  'neighbour run starting with a break':
    '<w:r><w:t>Line one</w:t></w:r><w:r><w:br/><w:t>Line two</w:t></w:r>',
  'three same-format runs each ending in a break':
    '<w:r><w:t>One</w:t><w:br/></w:r><w:r><w:t>Two</w:t><w:br/></w:r><w:r><w:t>Three</w:t></w:r>',
  'break and text in one run':
    '<w:r><w:t>Alpha</w:t><w:br/><w:t>Beta</w:t></w:r>',
  'break-only run between different formats':
    '<w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Plain</w:t></w:r>',
  'break-only run with its own formatting':
    '<w:r><w:t>Name</w:t></w:r><w:r><w:rPr><w:sz w:val="8"/></w:rPr><w:br/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Address</w:t></w:r>',
  'formatted run with an internal break':
    '<w:r><w:rPr><w:b/></w:rPr><w:t>Bold one</w:t><w:br/><w:t>Bold two</w:t></w:r>',
  'break inside a hyperlink':
    '<w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId1" xmlns:r="urn:r"><w:r><w:t>link a</w:t><w:br/><w:t>link b</w:t></w:r></w:hyperlink>',
  'carriage return (w:cr)':
    '<w:r><w:t>Before</w:t><w:cr/><w:t>After</w:t></w:r>',
  'page break in its own run':
    '<w:r><w:t>Chapter end</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>Next chapter</w:t></w:r>',
  'breaks mixed with tabs':
    '<w:r><w:t>Key</w:t><w:tab/><w:t>Value</w:t><w:br/></w:r><w:r><w:t>Key2</w:t><w:tab/><w:t>Value2</w:t></w:r>',
};

for (const [name, runsXml] of Object.entries(layouts)) {
  test(`line breaks keep reading order through a round trip: ${name}`, () => {
    const original = readingOrder(parseBody(`<w:p>${runsXml}</w:p>`).getElementsByTagName('w:p')[0]);
    const { p } = roundTrip(runsXml);
    assert.equal(readingOrder(p), original);
  });
}

test('merging same-format runs appends text after an earlier break, not before it', () => {
  const dom = parseBody('<w:p><w:r><w:t>Line one</w:t><w:br/></w:r><w:r><w:t>Line two</w:t></w:r><w:r><w:br/><w:t>Line three</w:t></w:r></w:p>');
  const p = dom.getElementsByTagName('w:p')[0];
  normalizeParagraph(p);

  const runs = p.getElementsByTagName('w:r');
  assert.equal(runs.length, 1, 'identically formatted runs merge into one');
  assert.deepEqual(
    (Array.from(runs[0].childNodes) as any[]).map((n) => n.nodeName),
    ['w:t', 'w:br', 'w:t', 'w:br', 'w:t']
  );
  assert.equal(readingOrder(p), 'Line one⏎Line two⏎Line three');
});

test('merging runs still joins directly adjacent text', () => {
  const dom = parseBody('<w:p><w:r><w:t xml:space="preserve">Hel</w:t></w:r><w:r><w:t xml:space="preserve">lo </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>');
  const p = dom.getElementsByTagName('w:p')[0];
  normalizeParagraph(p);

  const texts = p.getElementsByTagName('w:t');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].textContent, 'Hello world');
});

test('a translated paragraph keeps each line in its original position', () => {
  const { p } = roundTrip(
    '<w:r><w:t>Line one</w:t><w:br/></w:r><w:r><w:t>Line two</w:t></w:r>',
    (text) => text.replace('Line one', 'Első sor').replace('Line two', 'Második sor')
  );
  assert.equal(readingOrder(p), 'Első sor⏎Második sor');
});

test('a break inside formatted text stays inside that formatted run', () => {
  const { p, tagged } = roundTrip('<w:r><w:rPr><w:b/></w:rPr><w:t>Bold one</w:t><w:br/><w:t>Bold two</w:t></w:r>');
  assert.equal(tagged, '[f1]Bold one[br/]Bold two[/f1]');

  const runs = p.getElementsByTagName('w:r');
  assert.equal(runs.length, 1);
  assert.deepEqual(
    (Array.from(runs[0].childNodes) as any[]).map((n) => n.nodeName),
    ['w:rPr', 'w:t', 'w:br', 'w:t']
  );
  assert.equal(runs[0].getElementsByTagName('w:b').length, 1, 'bold formatting must survive');
  assert.ok(!p.toString().includes('[br/]'), 'the tag must not leak into the document as text');
});

test('a break alone in a formatted run is emitted without an extra tag and gets its formatting back', () => {
  const { p, tagged } = roundTrip(
    '<w:r><w:t>Name</w:t></w:r><w:r><w:rPr><w:sz w:val="8"/></w:rPr><w:br/></w:r><w:r><w:t>Address</w:t></w:r>'
  );
  assert.equal(tagged, 'Name[br/]Address');

  const br = p.getElementsByTagName('w:br')[0];
  const breakRun = br.parentNode;
  assert.equal(breakRun.getElementsByTagName('w:sz').length, 1, 'the break run keeps its own formatting');
  assert.equal(breakRun.getElementsByTagName('w:t').length, 0, 'text does not pick up the break run formatting');
});

test('page breaks and carriage returns keep their kind', () => {
  const { p } = roundTrip(
    '<w:r><w:t>Page one</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>Page two</w:t><w:cr/><w:t>Same page</w:t><w:br w:type="column"/><w:t>Next column</w:t></w:r>'
  );
  const breaks = (Array.from(p.getElementsByTagName('*')) as any[]).filter((n) => n.nodeName === 'w:br' || n.nodeName === 'w:cr');
  assert.deepEqual(
    breaks.map((n) => `${n.nodeName}:${n.getAttribute('w:type') || ''}`),
    ['w:br:page', 'w:cr:', 'w:br:column']
  );
  assert.equal(readingOrder(p), 'Page one⏎Page two⏎Same page⏎Next column');
});

test('formatting inside a hyperlink is rebuilt, not written out as literal tags', () => {
  const { p } = roundTrip('<w:hyperlink w:anchor="top"><w:r><w:rPr><w:b/></w:rPr><w:t>bold link</w:t><w:br/><w:t>second line</w:t></w:r></w:hyperlink>');
  const link = p.getElementsByTagName('w:hyperlink')[0];
  assert.ok(link, 'hyperlink is rebuilt');
  assert.equal(link.getAttribute('w:anchor'), 'top');
  assert.equal(link.getElementsByTagName('w:b').length, 1, 'bold formatting is applied inside the link');
  assert.equal(readingOrder(link), 'bold link⏎second line');
  assert.ok(!/\[\/?(f\d+|br\/)\]/.test(p.toString()), 'no tags leak into the document text');
});

test('escaped characters and literal brackets next to breaks survive', () => {
  const { p } = roundTrip('<w:r><w:t>A &amp; B &lt;x&gt;</w:t><w:br/><w:t>Math: [[a, b]]</w:t></w:r>');
  assert.equal(readingOrder(p), 'A & B <x>⏎Math: [[a, b]]');
});

test('a document with line breaks translates end to end in the original order', async () => {
  const input = buildDocx(
    '<w:p><w:r><w:t>Line one</w:t><w:br/></w:r><w:r><w:t>Line two</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Heading</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>Body</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>No breaks here.</w:t></w:r></w:p>'
  );
  const mismatches: string[] = [];
  const output = await translateDocx(input, {
    from: 'en',
    to: 'hu',
    verify: false,
    backendImpl: upperCaseBackend,
    onTagMismatch: (id) => mismatches.push(id),
  });

  assert.deepEqual(mismatches, []);
  const xml = new AdmZip(output).readAsText('word/document.xml');
  let parseFailed = false;
  const dom = new DOMParser({ onError: () => { parseFailed = true; } }).parseFromString(xml, 'application/xml');
  assert.equal(parseFailed, false, 'output must be well-formed XML');

  const paragraphs = Array.from(dom.getElementsByTagName('w:p')).map(readingOrder);
  assert.deepEqual(paragraphs, ['LINE ONE⏎LINE TWO', 'HEADING⏎BODY', 'NO BREAKS HERE.']);
  assert.ok(xml.includes('w:type="page"'), 'the page break stays a page break');
  assert.ok(!xml.includes('[br/]'), 'no tags leak into the document');
});

test('paragraphs holding only breaks are left alone and never sent to the translator', async () => {
  const input = buildDocx(
    '<w:p><w:r><w:t>Chapter one</w:t></w:r></w:p>' +
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:br/></w:r><w:r><w:t xml:space="preserve"> </w:t><w:br/></w:r></w:p>' +
    '<w:p><w:hyperlink w:anchor="top"><w:r><w:br/></w:r></w:hyperlink></w:p>' +
    '<w:p><w:r><w:t>Chapter two</w:t></w:r></w:p>'
  );
  const sent: string[] = [];
  const mismatches: string[] = [];
  const output = await translateDocx(input, {
    from: 'en',
    to: 'hu',
    verify: false,
    backendImpl: {
      name: 'recording',
      async translateBatch(texts: string[]) {
        sent.push(...texts);
        return texts.map((text) => text.toUpperCase());
      },
    },
    onTagMismatch: (id) => mismatches.push(id),
  });

  assert.deepEqual(sent, ['Chapter one', 'Chapter two'], 'only paragraphs with text cost translation quota');
  assert.deepEqual(mismatches, [], 'break-only paragraphs must not be reported as source-retained');

  const xml = new AdmZip(output).readAsText('word/document.xml');
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const paragraphs = Array.from(dom.getElementsByTagName('w:p')).map(readingOrder);
  assert.deepEqual(paragraphs, ['CHAPTER ONE', '⏎', '⏎ ⏎', '⏎', 'CHAPTER TWO']);
  assert.ok(xml.includes('w:type="page"'), 'the page break is untouched');
});

// reconstructParagraph is exported and may be handed text that never went through validateTags.
// Unexpected input must degrade to plain content, never crash or leak tags.
test('reconstruction degrades safely on unexpected tags', () => {
  const dom = parseBody('<w:p><w:r><w:t>A</w:t><w:br w:type="page"/><w:t>B</w:t></w:r></w:p>');
  const p = dom.getElementsByTagName('w:p')[0];
  const [block] = extractBlocksFromDOM(dom, 'word/document.xml');

  // An extra [br/] beyond the recorded breaks, an unknown container and a stray closer.
  reconstructParagraph(dom, p, 'A[br/]B[br/]C [h9]D[/h9] E[/f7][/h1] F', block.styleMap);

  assert.equal(readingOrder(p), 'A⏎B⏎C D E F');
  const breaks = Array.from(p.getElementsByTagName('w:br')) as any[];
  assert.equal(breaks[0].getAttribute('w:type'), 'page', 'the recorded break keeps its kind');
  assert.equal(breaks[1].getAttribute('w:type') || '', '', 'an unrecorded break becomes a plain line break');
  assert.equal(p.getElementsByTagName('w:hyperlink').length, 0, 'no container is invented for an unknown id');
});
