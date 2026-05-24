import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/**
 * Handles DOCX file operations: loading, parsing, and saving
 * Manages the internal ZIP structure and XML DOM documents
 */
export class DocxHandler {
  private filePath: string;
  private zip: AdmZip | null;
  private doms: Map<string, Document>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.zip = null;
    this.doms = new Map();
  }

  /**
   * Load the DOCX file and locate all structural XML components to translate
   * @returns Array of part names that were loaded (document.xml, headers, footers)
   */
  load(): string[] {
    this.zip = new AdmZip(this.filePath);
    this.doms.clear();
    
    // List all files inside the docx zip
    const entries = this.zip.getEntries();
    
    // Find main document, headers, and footers
    const targetParts = entries
      .map((entry: { entryName: string }) => entry.entryName)
      .filter((name: string) => 
        name === 'word/document.xml' || 
        /^word\/header\d+\.xml$/.test(name) || 
        /^word\/footer\d+\.xml$/.test(name)
      );

    const parser = new DOMParser();

    for (const part of targetParts) {
      const content = this.zip.readAsText(part);
      const dom = parser.parseFromString(content, 'application/xml');
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
   * Set/update the DOM for a specific XML part in our in-memory map
   * @param partName - The internal DOCX path
   * @param dom - The XML Document to store
   */
  setDOM(partName: string, dom: Document): void {
    this.doms.set(partName, dom);
  }

  /**
   * Serialize DOMs back to the zip archive and save to a new file
   * @param outputPath - Path where the translated DOCX will be saved
   */
  save(outputPath: string): void {
    if (!this.zip) {
      throw new Error('No document loaded to save');
    }

    const serializer = new XMLSerializer();

    for (const [partName, dom] of this.doms.entries()) {
      const xmlString = serializer.serializeToString(dom);
      this.zip.updateFile(partName, Buffer.from(xmlString, 'utf-8'));
    }

    this.zip.writeZip(outputPath);
  }
}
