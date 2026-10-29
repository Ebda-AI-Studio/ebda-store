/**
 * Byte-level file typing for catalogue import. The client's mime type and file name are ignored:
 * only the magic bytes decide what a file is, what it is stored as and what the extractor is sent.
 * JPEG, PNG, WebP, HEIC/HEIF and PDF are accepted; GIF, SVG, TIFF, BMP and everything else are refused.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { Unzlib } from 'fflate';
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

export type PdfRefusal =
  | 'UNREADABLE_PDF'
  | 'TOO_MANY_PAGES'
  | 'PDF_TOO_COMPLEX'
  | 'PDF_TOO_LARGE_AFTER_NORMALIZE';

export class PdfRefused extends Error {
  constructor(
    readonly code: PdfRefusal,
    readonly pages = 0
  ) {
    super(code);
  }
}

export const PDF_SCAN_LIMITS = {
  /** `/ObjStm` object streams: a normal export has a handful. */
  objectStreams: 8,
  /** Names in one `/Filter [ ... ]` chain. */
  filterChain: 2,
  /** Total inflated bytes across every stream, probed with a hard stop. */
  inflatedBytes: 48 * 1024 * 1024,
  streams: 5000,
} as const;

/**
 * Cheap pre-checks BEFORE any parser touches the file (decompression-bomb defence): too many object
 * streams, long filter chains, a declared /Length larger than the whole file, and a streaming
 * inflate probe of every stream that stops the moment the total output passes the cap. Input is fed
 * in 2 KB slices so one slice can never inflate past ~2 MB before the check runs.
 */
export function scanPdf(buf: Buffer): void {
  const refuse = () => new PdfRefused('PDF_TOO_COMPLEX');
  const text = buf.toString('latin1');
  if ((text.match(/\/ObjStm\b/g)?.length ?? 0) > PDF_SCAN_LIMITS.objectStreams) throw refuse();
  for (const m of text.matchAll(/\/Filter\s*\[([^\]]*)\]/g)) {
    if ((m[1].match(/\/[A-Za-z0-9]+/g)?.length ?? 0) > PDF_SCAN_LIMITS.filterChain) throw refuse();
  }
  for (const m of text.matchAll(/\/Length\s+(\d{1,12})(?!\d|\s+\d+\s+R)/g)) {
    if (Number(m[1]) > buf.length) throw refuse();
  }
  let total = 0;
  let streams = 0;
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i, 'latin1');
    if (s < 0) break;
    if (s >= 3 && buf.subarray(s - 3, s).toString('latin1') === 'end') {
      i = s + 6;
      continue;
    }
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf('endstream', start, 'latin1');
    if (e < 0) break;
    if (++streams > PDF_SCAN_LIMITS.streams) throw refuse();
    const z = new Unzlib(chunk => {
      total += chunk.length;
    });
    try {
      for (let o = start; o < e; o += 2048) {
        z.push(buf.subarray(o, Math.min(o + 2048, e)), o + 2048 >= e);
        if (total > PDF_SCAN_LIMITS.inflatedBytes) throw refuse();
      }
    } catch (err) {
      if (err instanceof PdfRefused) throw err;
      // not a zlib stream (images, fonts, plain): nothing to inflate
    }
    if (total > PDF_SCAN_LIMITS.inflatedBytes) throw refuse();
    i = e + 9;
  }
}

/**
 * Parse a PDF with a real parser (the page tree, not a text scan, so object streams and crafted
 * decoys cannot hide pages), refuse one that is unreadable, encrypted, too complex or over
 * `maxPages` (checked BEFORE any page is copied), and re-emit it containing EXACTLY the counted pages.
 * The re-emitted bytes (capped at `maxBytes`) are what is stored and sent to the model, so pages sent ==
 * pages counted == pages charged; scripts, open-actions and embedded files do not survive the copy.
 * Runs in the job step, never in the request handler.
 */
export async function normalizePdf(
  buf: Buffer,
  maxPages: number,
  maxBytes: number
): Promise<{ bytes: Buffer; pages: number }> {
  scanPdf(buf);
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
  let bytes: Buffer;
  try {
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach(p => out.addPage(p));
    if (out.getPageCount() !== pages) throw new Error('page count mismatch');
    bytes = Buffer.from(await out.save({ useObjectStreams: false }));
  } catch {
    throw new PdfRefused('UNREADABLE_PDF');
  }
  if (bytes.length > maxBytes) throw new PdfRefused('PDF_TOO_LARGE_AFTER_NORMALIZE');
  return { bytes, pages };
}

/** Display-only name: no path, no control or bidi characters, capped. Never used as a storage key. */
export function displayFileName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').slice(0, 120);
}
