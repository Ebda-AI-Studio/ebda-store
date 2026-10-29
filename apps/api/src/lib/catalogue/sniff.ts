/**
 * Byte-level file typing for catalogue import. The client's mime type and file name are ignored:
 * only the magic bytes decide what a file is, what it is stored as and what the extractor is sent.
 * JPEG, PNG, WebP, HEIC/HEIF and PDF are accepted; GIF, SVG, TIFF, BMP and everything else are refused.
 */
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

/** Pages in a PDF, counted from `/Type /Page` objects (not `/Pages`). At least 1. Cheap, no parser. */
export function countPdfPages(buf: Buffer): number {
  const text = buf.toString('latin1');
  const n = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return Math.max(1, n);
}

/** PDFs carrying active content are accepted (they are only bytes, never executed) but flagged. */
export function pdfHasActiveContent(buf: Buffer): boolean {
  const head = buf.subarray(0, 1_048_576).toString('latin1');
  return /\/(JS|JavaScript|OpenAction|Launch|EmbeddedFile)\b/.test(head);
}

/** Display-only name: no path, no control or bidi characters, capped. Never used as a storage key. */
export function displayFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').slice(0, 120);
}
