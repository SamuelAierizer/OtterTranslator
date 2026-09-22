import fs from 'fs';
import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { assertIsDocx, assertNoZipBomb, assertPartSize } from './guards.js';

/**
 * Handles DOCX file operations: loading, parsing, and saving
 * Manages the internal ZIP structure and XML DOM documents
 */
export class DocxHandler {
  private buffer: Buffer;
  private zip: AdmZip | null;
  private doms: Map<string, Document>;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.zip = null;
    this.doms = new Map();
  }

  /**
   * Convenience helper for the CLI: load a DocxHandler directly from a file path.
   */
  static fromFile(filePath: string): DocxHandler {
    return new DocxHandler(fs.readFileSync(filePath));
  }

  /**
   * Load the DOCX file and locate all structural XML components to translate
   * @returns Array of part names that were loaded (document.xml, headers, footers)
   */
  load(): string[] {
    assertIsDocx(this.buffer);
    this.zip = new AdmZip(this.buffer);
    assertNoZipBomb(this.zip);
    this.doms.clear();
    
    // List all files inside the docx zip
    const entries = this.zip.getEntries();
    
    // Find main document, headers, and footers
    const targetParts = entries
      .map((entry: { entryName: string }) => entry.entryName)
      .filter((name: string) => 
        name === 'word/document.xml' || 
        /^word\/header\d+\.xml$/.test(name) || 
        /^word\/footer\d+\.xml$/.test(name) ||
        name === 'word/footnotes.xml' ||
        name === 'word/endnotes.xml'
      );

    const parser = new DOMParser();

    for (const part of targetParts) {
      const content = this.zip.readFile(part);
      if (!content) {
        throw new Error(`Unable to read DOCX part: ${part}`);
      }
      assertPartSize(content.length);
      const dom = parser.parseFromString(content.toString('utf-8'), 'application/xml');
      this.doms.set(part, dom);
    }

    return Array.from(this.doms.keys());
  }

  /**
   * Get the DOM for a specific XML part
   * @param partName - The internal DOCX path (e.g., 'word/document.xml')
   * @returns The parsed XML Document
   */
  getDOM(partName: string): Document {
    const dom = this.doms.get(partName);
    if (!dom) {
      throw new Error(`DOM not found for part: ${partName}`);
    }
    return dom;
  }

  /**
   * Expose the underlying zip archive (e.g. for zip-bomb / entry-count guards).
   */
  getZip(): AdmZip {
    if (!this.zip) {
      throw new Error('No document loaded');
    }
    return this.zip;
  }

  /**
   * Set/update the DOM for a specific XML part in our in-memory map
   * @param partName - The internal DOCX path
   * @param dom - The XML Document to store
   */
  setDOM(partName: string, dom: Document): void {
    this.doms.set(partName, dom);
  }

  /**
   * Serialize DOMs back to the zip archive and return the resulting DOCX bytes.
   */
  toBuffer(): Buffer {
    if (!this.zip) {
      throw new Error('No document loaded to save');
    }

    const serializer = new XMLSerializer();

    for (const [partName, dom] of this.doms.entries()) {
      const xmlString = serializer.serializeToString(dom);
      this.zip.updateFile(partName, Buffer.from(xmlString, 'utf-8'));
    }

    return this.zip.toBuffer();
  }

  /**
   * Convenience helper for the CLI: write the translated DOCX to a file path.
   */
  saveToFile(outputPath: string): void {
    fs.writeFileSync(outputPath, this.toBuffer());
  }
}
