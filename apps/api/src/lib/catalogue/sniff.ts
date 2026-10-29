/**
 * Byte-level file typing for catalogue import. The client's mime type and file name are ignored:
 * only the magic bytes decide what a file is, what it is stored as and what the extractor is sent.
 * JPEG, PNG, WebP, HEIC/HEIF and PDF are accepted; GIF, SVG, TIFF, BMP and everything else are refused.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { sniffImage } from '../upload-sniff';

export type CatalogueMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/heic'
  | 'application/pdf';

export const CATALOGUE_EXT: Record<CatalogueMime, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']);
/** `%PDF-` must start within the first 1,024 bytes (the PDF spec's own tolerance). */
const PDF_HEADER_WINDOW = 1024;

export function sniffCatalogueFile(
  buf: Buffer
): { kind: 'image' | 'pdf'; mime: CatalogueMime } | null {
  const img = sniffImage(buf);
  if (img === 'image/jpeg' || img === 'image/png' || img === 'image/webp') {
    return { kind: 'image', mime: img };
  }
  if (img) return null; // GIF
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    if (HEIC_BRANDS.has(buf.subarray(8, 12).toString('latin1'))) {
      return { kind: 'image', mime: 'image/heic' };
    }
  }
  if (buf.subarray(0, PDF_HEADER_WINDOW).includes('%PDF-', 0, 'latin1')) {
    return { kind: 'pdf', mime: 'application/pdf' };
  }
  return null;
}

export class PdfRefused extends Error {
  constructor(
    readonly code: 'UNREADABLE_PDF' | 'TOO_MANY_PAGES',
    readonly pages = 0
  ) {
    super(code);
  }
}

/**
 * Parse a PDF with a real parser (the page tree, not a text scan, so object streams and crafted
 * decoys cannot hide pages), refuse one that is unreadable, encrypted or over `maxPages`, and
 * re-emit it containing EXACTLY the counted pages. The re-emitted bytes are what is stored and sent
 * to the model, so pages sent == pages counted == pages charged; scripts, open-actions, launch
 * actions and embedded files do not survive the copy.
 */
export async function normalizePdf(
  buf: Buffer,
  maxPages: number
): Promise<{ bytes: Buffer; pages: number }> {
  let src;
  try {
    src = await PDFDocument.load(buf, { throwOnInvalidObject: true, updateMetadata: false });
  } catch {
    throw new PdfRefused('UNREADABLE_PDF');
  }
  let pages: number;
  try {
    pages = src.getPageCount();
  } catch {
    throw new PdfRefused('UNREADABLE_PDF');
  }
  if (pages < 1) throw new PdfRefused('UNREADABLE_PDF');
  if (pages > maxPages) throw new PdfRefused('TOO_MANY_PAGES', pages);
  try {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach(p => out.addPage(p));
    if (out.getPageCount() !== pages) throw new Error('page count mismatch');
    return { bytes: Buffer.from(await out.save({ useObjectStreams: false })), pages };
  } catch {
    throw new PdfRefused('UNREADABLE_PDF');
  }
}

/** Display-only name: no path, no control or bidi characters, capped. Never used as a storage key. */
export function displayFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').slice(0, 120);
}
