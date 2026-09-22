#!/usr/bin/env node
/**
 * Generates small DOCX fixtures programmatically (no Word/LibreOffice dependency)
 * so tests have real, minimal-but-valid .docx files to exercise the pipeline against.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

// A 1x1 transparent PNG, just enough bytes to be a real image part.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const DOCUMENT_XMLNS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
].join(' ');

function buildDocx(bodyXml: string, opts: { withMedia?: boolean } = {}): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${DOCUMENT_XMLNS}>
  <w:body>
${bodyXml}
    <w:sectPr/>
  </w:body>
</w:document>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf-8'));
  zip.addFile('_rels/.rels', Buffer.from(ROOT_RELS, 'utf-8'));
  zip.addFile('word/document.xml', Buffer.from(document, 'utf-8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(DOCUMENT_RELS, 'utf-8'));
  if (opts.withMedia) {
    zip.addFile('word/media/image1.png', Buffer.from(TINY_PNG_BASE64, 'base64'));
  }
  return zip.toBuffer();
}

const fixtures: Record<string, Buffer> = {
  'plain-paragraph.docx': buildDocx(`
    <w:p><w:r><w:t>Hello, this is a plain paragraph.</w:t></w:r></w:p>`),

  'mixed-runs.docx': buildDocx(`
    <w:p>
      <w:r><w:t xml:space="preserve">Some </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t></w:r>
      <w:r><w:t xml:space="preserve"> and </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>
      <w:r><w:t xml:space="preserve"> text.</w:t></w:r>
    </w:p>`),

  'hyperlink.docx': buildDocx(`
    <w:p>
      <w:r><w:t xml:space="preserve">Visit our </w:t></w:r>
      <w:hyperlink r:id="rId1">
        <w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>website</w:t></w:r>
      </w:hyperlink>
      <w:r><w:t xml:space="preserve"> for more info.</w:t></w:r>
    </w:p>`),

  'inline-image.docx': buildDocx(`
    <w:p>
      <w:r><w:t xml:space="preserve">Look at this </w:t></w:r>
      <w:r>
        <w:drawing>
          <wp:inline>
            <wp:extent cx="914400" cy="914400"/>
            <a:graphic>
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic>
                  <pic:blipFill><a:blip r:embed="rId2"/></pic:blipFill>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
      <w:r><w:t xml:space="preserve"> image, mid sentence.</w:t></w:r>
    </w:p>`, { withMedia: true }),

  'text-box.docx': buildDocx(`
    <w:p>
      <w:r><w:t xml:space="preserve">Before box. </w:t></w:r>
      <w:r>
        <w:pict>
          <v:shape>
            <v:textbox>
              <w:txbxContent>
                <w:p><w:r><w:t>Text inside the box.</w:t></w:r></w:p>
              </w:txbxContent>
            </v:textbox>
          </v:shape>
        </w:pict>
      </w:r>
      <w:r><w:t xml:space="preserve"> After box.</w:t></w:r>
    </w:p>`),

  'sdt.docx': buildDocx(`
    <w:p>
      <w:r><w:t xml:space="preserve">Paragraph with </w:t></w:r>
      <w:sdt>
        <w:sdtPr><w:alias w:val="Field"/></w:sdtPr>
        <w:sdtContent>
          <w:r><w:t>inline content control</w:t></w:r>
        </w:sdtContent>
      </w:sdt>
      <w:r><w:t xml:space="preserve"> text.</w:t></w:r>
    </w:p>`)
};

for (const [name, buffer] of Object.entries(fixtures)) {
  const outPath = path.join(FIXTURES_DIR, name);
  const fs = await import('fs');
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(outPath, buffer);
  console.log(`Wrote ${outPath}`);
}
