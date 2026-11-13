import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import AdmZip from 'adm-zip';
import { serializeParagraph, extractBlocksFromDOM } from '../src/engine/xml-parser.ts';
import { reconstructParagraph } from '../src/engine/reconstructor.ts';
import { translateDocx } from '../src/engine/index.ts';
import { validateTags } from '../src/engine/tags.ts';
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function round(body: string) {
 const dom = new DOMParser().parseFromString(`<w:p xmlns:w="${ns}">${body}</w:p>`, 'application/xml');
 const p = dom.documentElement!; const block = serializeParagraph(p);
 reconstructParagraph(dom, p, block.text, block.styleMap); return { xml: p.toString(), block, p };
}
for (const element of ['<w:footnoteReference w:id="1"/>', '<w:endnoteReference w:id="2"/>', '<w:footnoteRef/>', '<w:endnoteRef/>', '<w:sym w:char="F0A3" w:font="Wingdings"/>', '<w:noBreakHyphen/>', '<w:softHyphen/>', '<w:fldChar w:fldCharType="begin"/>', '<w:instrText xml:space="preserve"> PAGE </w:instrText>', '<w:fldChar w:fldCharType="end"/>']) {
 test(`F06/F08 preserves ${element}`, () => assert.ok(round(`<w:r><w:t>word</w:t></w:r><w:r>${element}</w:r>`).xml.includes(element)));
}
test('F08 formatted tab-only run survives', () => assert.match(round('<w:r><w:t>Name</w:t></w:r><w:r><w:rPr><w:u/></w:rPr><w:tab/></w:r>').xml, /<w:u\/>.*<w:tab\/>/));
test('F09 content controls retain properties and content wrapper', () => assert.match(round('<w:sdt><w:sdtPr><w:tag w:val="x"/></w:sdtPr><w:sdtContent><w:r><w:t>word</w:t></w:r></w:sdtContent></w:sdt>').xml, /<w:sdtPr>.*<w:sdtContent>/));
test('F09 field instruction survives', () => assert.match(round('<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>').xml, /w:instr=" PAGE "/));
test('F10 dropped tabs fail validation', () => assert.equal(validateTags('a\tb', 'a b'), false));
test('F13 literal marker text survives', () => assert.equal(round('<w:r><w:t>[br/] [f1] x [/f1] &amp;lt;</w:t></w:r>').p.textContent, '[br/] [f1] x [/f1] &lt;'));
test('F22 plain text provider payload contains raw punctuation', () => assert.equal(round('<w:r><w:t>He said &quot;don&apos;t&quot; &amp; left &lt;now&gt;.</w:t></w:r>').block.text, `He said "don't" & left <now>.`));
test('F14 image-only paragraphs are not extracted', () => { const dom = new DOMParser().parseFromString(`<w:p xmlns:w="${ns}"><w:r><w:drawing/></w:r></w:p>`, 'application/xml'); assert.equal(extractBlocksFromDOM(dom, 'word/document.xml').length, 0); });
for (const mixedRun of [false, true]) test(`F07 text box translation reaches the output (mixed run: ${mixedRun})`, async () => {
 const zip = new AdmZip(); zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
 zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>inside</w:t></w:r></w:p></w:txbxContent></w:drawing>${mixedRun ? '' : '</w:r><w:r>'}<w:t>outside</w:t></w:r></w:p></w:body></w:document>`));
 const output = await translateDocx(zip.toBuffer(), { from:'en', to:'hu', verify:false, backendImpl:{ name:'test', async translateBatch(texts) { return texts.map(t => t.replace('inside','belül').replace('outside','kívül')); } } });
 const xml = new AdmZip(output).readAsText('word/document.xml'); assert.ok(xml.includes('belül')); assert.ok(xml.includes('kívül')); assert.ok(!xml.includes('inside'));
});
