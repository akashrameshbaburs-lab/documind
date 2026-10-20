import path from "node:path";
import mammoth from "mammoth";

export interface ExtractedPage {
  page: number;
  text: string;
}

export type FileKind = "pdf" | "docx" | "txt" | "md";

export function kindFromExt(ext: string): FileKind | null {
  switch (ext.toLowerCase()) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "txt":
      return "txt";
    case "md":
      return "md";
    default:
      return null;
  }
}

/** Minimal structural typing for the parts of the pdf.js API we use. */
interface PdfTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}
interface PdfTextContent {
  items: PdfTextItem[];
}
interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfJsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument> };
}

// Loaded lazily so the (large) pdf.js bundle is only unpacked when a PDF is
// actually ingested - keeping cold start and memory use low.
let pdfjsPromise: Promise<PdfJsModule> | null = null;
function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfJsModule>;
  }
  return pdfjsPromise;
}

/** Directory holding pdf.js standard font metrics (bundled in node_modules, so extraction is offline). */
function standardFontDataUrl(): string {
  const dir = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  return dir.split(path.sep).join("/");
}

/**
 * PDF text extraction with REAL page numbers.
 *
 * pdf.js is driven page by page, so the 1-based page index returned here is
 * the true PDF page. Text items within a page are grouped into lines by their
 * Y coordinate (2pt tolerance). Lines that are separated by an unusually large
 * vertical gap (paragraph spacing) are joined with a blank line, so paragraph
 * structure survives extraction. Pages that yield no extractable text (e.g.
 * pure scans) come back empty - OCR for scanned PDFs is explicitly out of scope
 * and listed as roadmap.
 */
export async function extractPdfPages(buffer: Buffer): Promise<ExtractedPage[]> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    // No network, no eval, no canvas: text-layer extraction only.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  }).promise;

  const pages: ExtractedPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines: Array<{ y: number; parts: string[] }> = [];
      for (const item of content.items) {
        if (typeof item.str !== "string" || item.str.length === 0) continue;
        const y = item.transform ? item.transform[5] : Number.NaN;
        const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
        if (last !== undefined && Number.isFinite(y) && Math.abs(last.y - y) <= 2) {
          last.parts.push(item.str);
        } else {
          lines.push({ y: Number.isFinite(y) ? y : 0, parts: [item.str] });
        }
      }
      const rendered = lines
        .map((l) => ({ y: l.y, text: l.parts.join(" ").replace(/\s+/g, " ").trim() }))
        .filter((l) => l.text.length > 0);

      // Detect paragraph breaks: a vertical gap larger than 1.45x the page's
      // typical line height (and > 18pt absolute) means the author inserted
      // paragraph spacing between those lines. (Calibrated on the fixtures:
      // 15.7pt line height vs 23.7-26.9pt paragraph gaps.)
      const deltas: number[] = [];
      for (let j = 1; j < rendered.length; j++) deltas.push(rendered[j - 1].y - rendered[j].y);
      const sorted = [...deltas].sort((a, b) => a - b);
      const medianDelta = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      const paraThreshold = Math.max(18, medianDelta * 1.45);

      const textParts: string[] = [];
      for (let j = 0; j < rendered.length; j++) {
        if (j > 0) {
          const gap = rendered[j - 1].y - rendered[j].y;
          textParts.push(gap > paraThreshold ? "\n\n" : "\n");
        }
        textParts.push(rendered[j].text);
      }
      pages.push({ page: i, text: textParts.join("") });
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }
  return pages;
}

/**
 * DOCX extraction via mammoth (raw paragraph text). DOCX has no fixed page
 * geometry, so pages are approximated downstream by the chunker using the
 * lines-per-page constant (same as txt/md).
 */
export async function extractDocx(buffer: Buffer): Promise<ExtractedPage[]> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.replace(/\r\n/g, "\n").trim();
  return [{ page: 1, text }];
}

/** Plain text / markdown: used verbatim. */
export function extractPlainText(buffer: Buffer): ExtractedPage[] {
  const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").trim();
  return [{ page: 1, text }];
}

export async function extractDocument(buffer: Buffer, kind: FileKind): Promise<ExtractedPage[]> {
  switch (kind) {
    case "pdf":
      return extractPdfPages(buffer);
    case "docx":
      return extractDocx(buffer);
    case "txt":
    case "md":
      return extractPlainText(buffer);
  }
}
